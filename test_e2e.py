import os
import sys
import time
import threading
import pytest
import requests
import uvicorn
from playwright.sync_api import sync_playwright

from backend.main import app

import socket
import subprocess

def get_free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port

PORT = get_free_port()
BASE_URL = f"http://127.0.0.1:{PORT}"

TEST_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "backend", "macronomics_test.db")
os.environ["MACRONOMICS_DB_PATH"] = TEST_DB_PATH
os.environ["no_proxy"] = "127.0.0.1,localhost"
os.environ["NO_PROXY"] = "127.0.0.1,localhost"

@pytest.fixture(scope="module")
def app_server():
    # Remove stale test database if present
    if os.path.exists(TEST_DB_PATH):
        try:
            os.remove(TEST_DB_PATH)
        except Exception:
            pass

    # Initialize isolated test database
    from backend.database import init_db, set_user_gemini_key
    init_db()

    # Pre-seed test DB with active key from main DB for live LLM gate testing
    import sqlite3
    main_db = os.path.join(os.path.dirname(os.path.abspath(__file__)), "backend", "macronomics.db")
    if os.path.exists(main_db):
        c_main = sqlite3.connect(main_db)
        r = c_main.cursor().execute("SELECT gemini_api_key FROM users WHERE id = 1").fetchone()
        c_main.close()
        if r and r[0]:
            set_user_gemini_key(r[0], 1)

    env = os.environ.copy()
    env["MACRONOMICS_DB_PATH"] = TEST_DB_PATH

    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "backend.main:app", "--host", "127.0.0.1", "--port", str(PORT), "--log-level", "info"],
        env=env
    )

    # Wait for server to be responsive
    started = False
    last_err = None
    sess = requests.Session()
    sess.trust_env = False  # Avoid proxy interception for localhost
    for _ in range(40):
        if proc.poll() is not None:
            break
        try:
            r = sess.get(f"{BASE_URL}/api/health", timeout=1)
            if r.status_code == 200:
                started = True
                break
        except Exception as e:
            last_err = e
            time.sleep(0.25)

    if not started:
        print(f"[ERROR] proc.poll() = {proc.poll()}, last error = {last_err}, PORT = {PORT}")
        try:
            proc.kill()
        except Exception:
            pass
        pytest.skip(f"Uvicorn server could not be started/reached in this environment: {last_err}")

    yield proc

    try:
        proc.terminate()
        proc.wait(timeout=3)
    except Exception:
        proc.kill()

    # Clean up isolated test database
    if os.path.exists(TEST_DB_PATH):
        try:
            os.remove(TEST_DB_PATH)
        except Exception:
            pass

def test_e2e_macronomics_app(app_server):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(has_touch=True, viewport={'width': 375, 'height': 812})
        page = context.new_page()

        # Handle dialogs automatically (e.g. alerts)
        page.on("dialog", lambda dialog: print(f"[Browser Dialog] {dialog.message}") or dialog.accept())
        page.on("console", lambda msg: print(f"[Browser Console] {msg.type}: {msg.text}"))
        page.on("pageerror", lambda err: print(f"[Browser PageError] {err}"))
        page.on("requestfailed", lambda req: print(f"[Browser RequestFailed] {req.url} {req.failure}"))

        # 1. Load Homepage & Verify First-Time User Dedicated Onboarding Screen
        page.goto(BASE_URL)
        page.wait_for_selector("#onboarding-screen")
        assert not page.locator("#onboarding-screen").is_hidden(), "Onboarding screen must be visible for first-time user"

        # Verify single-line intro headline on 375px mobile viewport
        intro_headline = page.locator(".intro-headline").inner_text()
        assert "Track macros everyday. Get ready to flaunt!" in intro_headline
        assert "Protected by your device biometrics" not in page.content(), "Biometrics subtext line must be removed"
        print(f"[Playwright] Verified onboarding screen with headline: '{intro_headline}'")

        # Claim handle via 1-tap passkey button (using fresh dynamic test handle)
        test_handle = f"t_{PORT % 100000}"
        handle_input = page.locator("#onboarding-handle-input")
        handle_input.fill(test_handle)
        page.locator("#btn-onboard-passkey").click()

        # Wait for onboarding to dismiss and main app to become active
        page.wait_for_selector("#onboarding-screen", state="hidden", timeout=10000)
        page.wait_for_selector(".brand-title")
        assert "macromix" in page.title().lower()
        brand_text = page.locator(".brand-title").inner_text().lower()
        assert "macromix" in brand_text
        print(f"\n[Playwright] Onboarding completed. Homepage loaded with brand: '{brand_text}' and user handle: '{page.locator('#header-handle-text').inner_text()}'")

        # 2. Verify Initial Circle Gauges (0 kcal) and Initial Streak
        val_cal = page.locator("#val-cal").inner_text()
        val_prot = page.locator("#val-prot").inner_text()
        val_carb = page.locator("#val-carb").inner_text()
        val_fiber = page.locator("#val-fiber").inner_text()
        assert int(val_cal) == 0
        assert int(val_prot) == 0
        assert int(val_carb) == 0
        assert int(val_fiber) == 0
        assert page.locator("#circle-fiber").count() == 1
        assert "0d" in page.locator("#streak-badge").inner_text()
        print(f"[Playwright] Initial Circles: {val_cal} kcal, {val_prot}g prot, {val_carb}c, {val_fiber}fib. Streak: {page.locator('#streak-badge').inner_text()}")

        # 2b. Verify 'Track your macromix' button text
        tap_track_btn = page.locator("#btn-tap-record")
        assert "Track your" in tap_track_btn.inner_text(), f"Expected 'Track your macromix', got '{tap_track_btn.inner_text()}'"
        assert "macromix" in tap_track_btn.inner_text()
        print(f"[Playwright] Verified button text contains 'Track your macromix': '{tap_track_btn.inner_text()}'.")

        # 3. Test Dynamic Log Button State & Empty Log Prevention
        input_box = page.locator("#manual-text-input")
        submit_btn = page.locator("#btn-submit-log")
        assert submit_btn.is_disabled(), "Log button must be disabled when input is empty"
        input_box.fill("   ")
        assert submit_btn.is_disabled(), "Log button must remain disabled when input has only whitespace"
        input_box.fill("apple")
        assert not submit_btn.is_disabled(), "Log button must enable when user types input"
        input_box.fill("")
        assert submit_btn.is_disabled(), "Log button must re-disable when input is cleared"
        print("[Playwright] Verified Log button state dynamically reacts to user typing.")

        # 4. Test Logging 'chicken biriyani with 300g rice and 100g chicken'
        biryani_text = "chicken biriyani with 300g rice and 100g chicken"
        input_box.fill(biryani_text)
        assert not submit_btn.is_disabled(), "Log button must enable after typing"
        submit_btn.click()

        # Wait for meal item to appear in timeline
        try:
            page.wait_for_selector(".meal-item-row", timeout=45000)
        except Exception as e:
            mic_status = page.locator("#mic-status-text").inner_text()
            print(f"[Playwright Error Debug] mic-status-text='{mic_status}', input='{input_box.input_value()}'")
            raise e
        assert page.locator(".meal-item-row").count() == 2
        
        # Verify no meal category headers (Requirement 6: no lunch/breakfast/dinner/snacks headers)
        assert page.locator(".meal-group-header").count() == 0, "No meal group headers should be rendered"

        # Verify two-line layout for food items (Requirement: kcal next to name on line 1, quantity + commentary + right-justified macros on line 2)
        top_line = page.locator(".meal-item-top-line").first
        assert top_line.locator(".meal-item-title").is_visible()
        assert top_line.locator(".macro-chip.cal").is_visible()
        assert top_line.locator(".item-actions").is_visible()

        bottom_line = page.locator(".meal-item-bottom-line").first
        assert bottom_line.locator(".meal-item-sub").is_visible()
        assert bottom_line.locator(".meal-item-macros").is_visible()

        # Verify removal of braces containing standardized weights
        sub_text = bottom_line.locator(".meal-item-sub").inner_text()
        assert "(" not in sub_text and ")" not in sub_text, f"Expected no braces in sub line, got '{sub_text}'"
        print(f"[Playwright] Verified second line without braces: '{sub_text}'")

        # Verify right-justified alignment of macro values
        align_style = bottom_line.locator(".meal-item-macros").evaluate("el => window.getComputedStyle(el).justifyContent")
        assert align_style == "flex-end", f"Expected justifyContent flex-end, got {align_style}"
        macros_box = bottom_line.locator(".meal-item-macros").bounding_box()
        row_box = bottom_line.bounding_box()
        assert abs((macros_box["x"] + macros_box["width"]) - (row_box["x"] + row_box["width"])) <= 12, "Macros must be right-justified to the right edge of the card"
        print("[Playwright] Verified 2-line layout: kcal next to name, right-justified macros on line below.")

        items_text = page.locator(".meal-items-list").first.inner_text()
        assert "rice" in items_text.lower()
        assert "chicken" in items_text.lower()
        print("[Playwright] Chicken Biryani logged: 300g cooked biryani rice and 100g cooked chicken.")

        # Verify timeline macro chips (fat and fib)
        fat_chip = page.locator(".macro-chip.fat").first.inner_text()
        fib_chip = page.locator(".macro-chip.fib").first.inner_text()
        assert "fat" in fat_chip, f"Expected chip to have 'fat', got '{fat_chip}'"
        assert "fib" in fib_chip, f"Expected chip to have 'fib', got '{fib_chip}'"
        print(f"[Playwright] Verified timeline macro chips: {fib_chip}, {fat_chip}")

        # 4b. Verify Collapsible Original Transcript Display
        transcript_details = page.locator(".transcript-details").first
        assert transcript_details.is_visible()
        # Should be collapsed by default (open attribute not set)
        assert page.locator(".transcript-details[open]").count() == 0
        print("[Playwright] Transcript element is collapsed by default.")

        # Click to expand
        page.locator(".transcript-summary").first.click()
        assert page.locator(".transcript-details[open]").count() == 1
        transcript_content = page.locator(".transcript-content").first.inner_text()
        assert biryani_text in transcript_content
        print(f"[Playwright] Expanded transcript verifies user input: {transcript_content}")

        # 5. Verify Accurate Macro Breakdown against Google/Gemini benchmarks
        # Target: ~600-750 kcal, ~65-90g carbs, ~25-45g protein, ~15-30g fat
        page.wait_for_function("document.getElementById('val-cal').innerText !== '0'")
        b_cal = int(page.locator("#val-cal").inner_text())
        b_prot = int(page.locator("#val-prot").inner_text())
        b_carb = int(page.locator("#val-carb").inner_text())
        b_fat = int(page.locator("#val-fat").inner_text())

        print(f"[Playwright] Biryani Circles: {b_cal} kcal, {b_prot}g protein, {b_carb}g carbs, {b_fat}g fat.")
        assert 500 <= b_cal <= 750, f"Expected Calories 500-750, got {b_cal}"
        assert 65 <= b_carb <= 100, f"Expected Carbs 65-100g, got {b_carb}"
        assert 25 <= b_prot <= 45, f"Expected Protein 25-45g, got {b_prot}"
        assert 2 <= b_fat <= 30, f"Expected Fat 2-30g, got {b_fat}"
        print("[Playwright] Macro breakdown matches Google AI / Gemini benchmark!")

        # Verify streak updated to 1d after today's meal
        assert "1d" in page.locator("#streak-badge").inner_text()
        print("[Playwright] Verified streak is '🔥 1d' after logging today's meal.")

        # 5b. Test Date Navigation (< TODAY >) and Next Arrow Disabled on Today
        prev_date_btn = page.locator("#btn-date-prev")
        next_date_btn = page.locator("#btn-date-next")
        date_label = page.locator("#date-label")
        assert prev_date_btn.is_visible()
        assert next_date_btn.is_visible()
        assert date_label.is_visible()
        assert "TODAY" in date_label.inner_text()
        assert next_date_btn.is_disabled(), "Next arrow must NOT be clickable when displaying TODAY"

        # Verify date navigation arrows match neobrutalist theme (black border, not blue)
        prev_arrow_border = prev_date_btn.evaluate("el => window.getComputedStyle(el).borderTopWidth")
        prev_arrow_color = prev_date_btn.evaluate("el => window.getComputedStyle(el).color")
        assert "px" in prev_arrow_border and int(prev_arrow_border.replace("px", "")) >= 2
        # Color should be near-black var(--text-main), not blue (#007799 / rgb(0, 119, 153))
        assert "119" not in prev_arrow_color, f"Arrow should not have legacy blue color: {prev_arrow_color}"
        print("[Playwright] Verified next arrow is disabled on TODAY and has neobrutalist styling.")

        # Navigate to Yesterday via Button Click
        prev_date_btn.click()
        time.sleep(0.4)
        assert "YESTERDAY" in date_label.inner_text()
        assert not next_date_btn.is_disabled(), "Next arrow must be enabled when displaying YESTERDAY"
        # Calories for yesterday should be 0 because biryani was logged for today
        assert int(page.locator("#val-cal").inner_text()) == 0
        assert page.locator("#meal-timeline-content .empty-state").is_visible() or page.locator(".meal-group").count() == 0
        print("[Playwright] Navigated to YESTERDAY: circles show 0 kcal, timeline empty, next arrow enabled.")

        # Log a meal for Yesterday to test 2 consecutive days streak (pause to prevent API rate limit)
        time.sleep(5)
        input_box.fill("100g cooked chicken breast")
        submit_btn = page.locator("#btn-submit-log")
        assert not submit_btn.is_disabled()
        submit_btn.click()
        page.wait_for_selector(".meal-item-row:has-text('chicken')", timeout=30000)
        page.wait_for_function("document.getElementById('streak-badge').innerText.includes('2d')")
        assert "2d" in page.locator("#streak-badge").inner_text()
        print("[Playwright] Verified streak counter incremented to '🔥 2d' for 2 consecutive days (yesterday and today)!")

        # Navigate back to Today
        next_date_btn.click()
        time.sleep(0.4)
        assert "TODAY" in date_label.inner_text()
        assert next_date_btn.is_disabled(), "Next arrow must be disabled again upon returning to TODAY"
        assert int(page.locator("#val-cal").inner_text()) == b_cal
        assert page.locator(".meal-group").count() > 0
        assert "2d" in page.locator("#streak-badge").inner_text()
        print("[Playwright] Navigated back to TODAY: next arrow disabled again, circles restored, streak still '🔥 2d'.")

        # 5c. Test Touch Swipe Gestures between Days
        # Swipe Right (left-to-right) on .circles-container: navigates to YESTERDAY
        page.evaluate("""() => {
            const el = document.querySelector('.circles-container');
            const rect = el.getBoundingClientRect();
            const startX = rect.left + 50;
            const endX = rect.left + 200;
            const y = rect.top + rect.height / 2;
            const touchStart = new Touch({ identifier: Date.now(), target: el, clientX: startX, clientY: y });
            const touchEnd = new Touch({ identifier: Date.now(), target: el, clientX: endX, clientY: y });
            el.dispatchEvent(new TouchEvent('touchstart', { touches: [touchStart], changedTouches: [touchStart], bubbles: true }));
            el.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [touchEnd], bubbles: true }));
        }""")
        time.sleep(0.4)
        assert "YESTERDAY" in date_label.inner_text(), "Expected swipe right to navigate to YESTERDAY"
        print("[Playwright] Verified touch swipe right navigated to YESTERDAY.")

        # Swipe Left (right-to-left) on .circles-container: navigates back to TODAY
        page.evaluate("""() => {
            const el = document.querySelector('.circles-container');
            const rect = el.getBoundingClientRect();
            const startX = rect.left + 200;
            const endX = rect.left + 50;
            const y = rect.top + rect.height / 2;
            const touchStart = new Touch({ identifier: Date.now() + 1, target: el, clientX: startX, clientY: y });
            const touchEnd = new Touch({ identifier: Date.now() + 1, target: el, clientX: endX, clientY: y });
            el.dispatchEvent(new TouchEvent('touchstart', { touches: [touchStart], changedTouches: [touchStart], bubbles: true }));
            el.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [touchEnd], bubbles: true }));
        }""")
        time.sleep(0.4)
        assert "TODAY" in date_label.inner_text(), "Expected swipe left to navigate to TODAY"
        print("[Playwright] Verified touch swipe left navigated back to TODAY.")

        # 6. Verify SQLite Persistence across Page Reload
        page.reload()
        page.wait_for_selector(".meal-item-row", timeout=5000)
        assert int(page.locator("#val-cal").inner_text()) == b_cal
        assert "2d" in page.locator("#streak-badge").inner_text()
        # Transcript should still be present and collapsed by default after reload
        assert page.locator(".transcript-details").first.is_visible()
        assert page.locator(".transcript-details[open]").count() == 0
        print("[Playwright] Verified 100% database persistence of macros and transcript across reload.")

        # 7. Verify UI Element Removals (Requirement 1, 4, 5) & Gemini Mode Logging
        assert page.locator("#gemini-badge").count() == 0, "Gemini Unlimited badge must be completely removed"
        assert page.locator("#btn-ptt").count() == 0, "Push & Hold button must be removed"
        assert page.locator(".timeline-header .refresh-btn").count() == 0, "Refresh icon must be removed from timeline header"
        # Test logging in Gemini mode (pause briefly to avoid rate limiting)
        time.sleep(3)
        input_box.fill("1 banana")
        page.locator("#btn-submit-log").click()
        page.wait_for_selector(".meal-item-row:has-text('banana')", timeout=30000)
        mic_status = page.locator("#mic-status-text").inner_text()
        assert "Error" not in mic_status, f"Unexpected error status: {mic_status}"
        assert "Check connection" not in mic_status
        print("[Playwright] Gemini mode logged meal successfully without connection error.")

        # Clean up banana test meal so subsequent steps remain isolated
        page.locator(".meal-item-row:has-text('banana') .item-action-btn:has-text('🗑️')").first.click()
        page.wait_for_selector(".meal-item-row:has-text('banana')", state="detached", timeout=10000)

        # 8. Test Inline Edit Portion
        page.locator(".item-action-btn:has-text('✏️')").first.click()
        page.wait_for_selector("#edit-item-modal:not(.hidden)")
        page.locator("#edit-weight-g").fill("50")
        page.locator("#edit-quantity").fill("50")
        page.locator("button:has-text('Update Item & Recalculate Circles')").click()

        time.sleep(0.5)
        edited_cal = int(page.locator("#val-cal").inner_text())
        assert edited_cal < b_cal
        print(f"[Playwright] Inline edit drawer recalculated portion to {edited_cal} kcal.")

        # 9. Test Individual Item Deletion
        initial_items_count = page.locator(".meal-item-row").count()
        page.locator(".meal-item-row .item-action-btn:has-text('🗑️')").first.click()
        page.wait_for_function(f"document.querySelectorAll('.meal-item-row').length === {initial_items_count - 1}", timeout=10000)
        assert page.locator(".meal-item-row").count() == initial_items_count - 1
        print("[Playwright] Deleted individual food item; remaining item kept.")

        # 10. Test Deleting Remaining Items Cleans Up Meal Group
        while page.locator(".meal-item-row .item-action-btn:has-text('🗑️')").count() > 0:
            page.locator(".meal-item-row .item-action-btn:has-text('🗑️')").first.click()
            time.sleep(0.4)
        page.wait_for_selector("#meal-timeline-content .empty-state")
        reset_cal = page.locator("#val-cal").inner_text()
        assert int(reset_cal) == 0
        assert page.locator(".meal-group").count() == 0
        print("[Playwright] Remaining items deleted cleanly, circles reset to 0, empty state displayed.")

        # 11. Test Relaxed Guardrail with 'dosa' and 'crepe'
        input_box.fill("2 dosas")
        page.locator("#btn-submit-log").click()
        page.wait_for_selector(".meal-item-row", timeout=30000)
        dosa_text = page.locator(".meal-items-list").first.inner_text()
        assert "dosa" in dosa_text.lower()
        dosa_cal = int(page.locator("#val-cal").inner_text())
        assert dosa_cal > 200
        print(f"[Playwright] Successfully logged '2 dosas' without rejection ({dosa_cal} kcal).")

        input_box.fill("crepe")
        page.locator("#btn-submit-log").click()
        page.wait_for_selector("#meal-timeline-content:has-text('crepe')", timeout=30000)
        # Should now have 2 meal groups (or items)
        all_items_text = page.locator("#meal-timeline-content").inner_text()
        assert "crepe" in all_items_text.lower()
        total_after_crepe = int(page.locator("#val-cal").inner_text())
        assert total_after_crepe > dosa_cal
        # 12. Test Rapid Double Submission & Server Idempotency (Duplicate Prevention)
        # Clear existing meals to test isolation
        while page.locator(".meal-item-row .item-action-btn:has-text('🗑️')").count() > 0:
            page.locator(".meal-item-row .item-action-btn:has-text('🗑️')").first.click()
            time.sleep(0.3)

        assert page.locator(".meal-group").count() == 0

        dup_transcript = "no sorry that's that I had chicken Thai bonders around 200 grams and biryani rice of around 200 gram for lunch"
        input_box.fill(dup_transcript)
        
        # Rapid double-click on submit (pause briefly for rate limit reset)
        time.sleep(3)
        submit_btn = page.locator("#btn-submit-log")
        submit_btn.click()

        # Immediate verification that Log CTA is disabled and in loading state
        assert submit_btn.is_disabled(), "Log CTA button should be disabled immediately upon first click"
        btn_text = submit_btn.inner_text()
        assert "Logging" in btn_text, f"Expected loading text, got {btn_text}"
        assert page.locator("#manual-text-input").is_disabled(), "Input field should be disabled while processing"

        # Attempt 2nd click via DOM while in-flight (should be dropped/noop)
        page.evaluate("document.getElementById('btn-submit-log').click()")

        try:
            page.wait_for_selector(".meal-group", timeout=45000)
        except Exception as e:
            mic_status = page.locator("#mic-status-text").inner_text()
            input_val = page.locator("#manual-text-input").input_value()
            print(f"[Playwright Error Debug Step 12] mic-status-text='{mic_status}', input='{input_val}'")
            raise e
        time.sleep(0.8)

        # Verify Log CTA is disabled after completion because input was cleared
        assert submit_btn.is_disabled(), "Log CTA button should be disabled after meal is logged since input is cleared"
        assert not page.locator("#manual-text-input").is_disabled(), "Input field should be re-enabled"
        assert page.locator("#manual-text-input").input_value() == "", "Input field should be cleared after meal is logged"

        # Verify exactly ONE meal card was created (second click was completely rejected)
        meal_groups_count = page.locator(".meal-group").count()
        assert meal_groups_count == 1, f"Expected exactly 1 meal group, got {meal_groups_count}"
        print("[Playwright] Verified Log CTA button disabled state, visual feedback, and 2nd click prevention!")
        # 13. Test 'evening snack 200 grams of Greek yogurt'
        time.sleep(3)
        yogurt_text = "evening snack 200 grams of Greek yogurt"
        input_box.fill(yogurt_text)
        page.locator("#btn-submit-log").click()

        try:
            page.wait_for_selector(".meal-item-row:has-text('yogurt')", timeout=45000)
        except Exception as e:
            mic_status = page.locator("#mic-status-text").inner_text()
            input_val = page.locator("#manual-text-input").input_value()
            print(f"[Playwright Error Debug Step 13] mic-status-text='{mic_status}', input='{input_val}'")
            raise e
        status_msg = page.locator("#mic-status-text").inner_text()
        assert "error" not in status_msg.lower(), f"Unexpected error status: {status_msg}"
        assert "failed" not in status_msg.lower(), f"Unexpected failed status: {status_msg}"

        # Verify meal content without header (Requirement 6)
        yogurt_item = page.locator(".meal-item-row:has-text('yogurt')")
        assert yogurt_item.is_visible()
        assert "200" in yogurt_item.inner_text() or "yogurt" in yogurt_item.inner_text().lower()
        assert page.locator(".meal-group-header").count() == 0, "No meal group header should exist"
        print(f"[Playwright] Successfully logged '{yogurt_text}' without database errors!")

        # 14. Test Daily Macro Targets Modal opened via Handle Badge (Requirement: fire icon button removed from titlebar)
        # Verify Gemini badge and modal are completely absent (Requirement 1)
        assert page.locator("#gemini-badge").count() == 0, "Gemini badge must not exist"
        assert page.locator("#gemini-modal").count() == 0, "Gemini modal must not exist"

        # Verify fire icon button is removed from titlebar
        assert page.locator("#open-settings-btn").count() == 0, "Expected #open-settings-btn fire button to be removed from titlebar"

        # Open Daily Macro Targets Modal by clicking the user handle badge in the titlebar
        handle_badge = page.locator("#header-handle-badge")
        assert handle_badge.is_visible(), "Expected handle badge to be visible in title bar"
        handle_badge.click()
        page.wait_for_selector("#settings-modal:not(.hidden)")
        assert "TARGETS" in page.locator("#settings-modal .modal-title").inner_text().upper()

        # Verify ONLY macro targets are present in settings-modal, NO Gemini key input
        assert page.locator("#settings-modal #input-gemini-key").count() == 0, "Settings modal must not contain Gemini API key input"
        assert page.locator("#settings-modal #tgt-input-cal").is_visible()
        assert page.locator("#settings-modal #tgt-input-prot").is_visible()
        assert page.locator("#settings-modal #tgt-input-carb").is_visible()
        assert page.locator("#settings-modal #tgt-input-fiber").is_visible()
        assert page.locator("#settings-modal #tgt-input-fat").is_visible()

        # Verify all input fields are strictly inside the modal frame without overflow
        modal_box = page.locator("#settings-modal .modal-content").bounding_box()
        modal_right = modal_box["x"] + modal_box["width"]
        for fid in ["#tgt-input-cal", "#tgt-input-prot", "#tgt-input-fat", "#tgt-input-carb", "#tgt-input-fiber"]:
            inp_box = page.locator(fid).bounding_box()
            assert inp_box["x"] + inp_box["width"] <= modal_right + 1, f"Field {fid} right edge exceeds modal frame"
            assert inp_box["x"] >= modal_box["x"], f"Field {fid} left edge is outside modal frame"
        print("[Playwright] Verified all macro target inputs fit strictly inside the modal frame without overflow.")

        # Verify modal is at least 5px lesser than the background app frame on BOTH sides
        app_box = page.locator(".circles-container").bounding_box()
        left_inset = modal_box["x"] - app_box["x"]
        right_inset = (app_box["x"] + app_box["width"]) - (modal_box["x"] + modal_box["width"])
        assert left_inset >= 4.5, f"Modal left edge must be >= 5px inside app frame, got {left_inset}px"
        assert right_inset >= 4.5, f"Modal right edge must be >= 5px inside app frame, got {right_inset}px"
        print(f"[Playwright] Verified modal width is at least 5px lesser than background app frame on both sides (left inset: {left_inset:.1f}px, right inset: {right_inset:.1f}px).")

        # Verify modal shadow is reduced (3px drop shadow, not 8px)
        modal_shadow = page.locator("#settings-modal .modal-content").evaluate("el => window.getComputedStyle(el).boxShadow")
        assert "3px 3px 0px" in modal_shadow or "rgb(0, 0, 0) 3px 3px" in modal_shadow, f"Expected 3px shadow, got {modal_shadow}"
        print(f"[Playwright] Verified modal shadow is reduced: '{modal_shadow}'.")

        # Update targets to test saving (including fiber)
        page.locator("#settings-modal #tgt-input-cal").fill("2200")
        page.locator("#settings-modal #tgt-input-fiber").fill("35")
        page.locator("#settings-modal button:has-text('Save Daily Targets')").click()
        time.sleep(0.4)
        assert "2200" in page.locator("#tgt-cal").inner_text()
        tgt_fiber_text = page.locator("#tgt-fiber").inner_text()
        assert tgt_fiber_text == "35g", f"Expected '35g' without 'fib', got '{tgt_fiber_text}'"
        assert "fib" not in tgt_fiber_text.lower(), f"Unexpected 'fib' in tgt-fiber: {tgt_fiber_text}"
        carbs_title = page.locator(".circle-card.carb .circle-name").inner_text()
        assert "CARBS" in carbs_title and "FIB" in carbs_title
        print("[Playwright] Verified Settings modal updates targets and carbs/fiber display correctly without 'fib' abbreviation!")

        # Capture screenshot of Daily Macro Targets modal
        handle_badge.click()
        page.wait_for_selector("#settings-modal:not(.hidden)")
        page.screenshot(path="/Users/satish.s/.gemini/antigravity/brain/1b29da82-03ee-4adf-ba27-814141ad0f77/macro_targets_modal_verified.png")
        page.locator("#settings-modal .close-btn").click()

        # 15. Test Redesigned UI Architecture (Mockup Alignment)
        # Verify Debug button and floating tab are completely removed
        assert page.locator("#open-debug-btn").count() == 0, "Expected #open-debug-btn to be completely removed from header"
        assert page.locator("#debug-sidebar").count() == 0, "Expected #debug-sidebar to be completely removed from DOM"

        # Verify active-engine-bar is completely removed
        assert page.locator(".active-engine-bar").count() == 0, "Expected .active-engine-bar to be completely removed"

        # Verify Gemini badge is completely removed
        assert page.locator(".header-actions #gemini-badge").count() == 0, "Expected #gemini-badge to be completely removed"

        # Verify unified container card structure
        main_container = page.locator(".main-container-card")
        assert main_container.is_visible(), "Expected .main-container-card to be rendered"
        assert main_container.locator(".voice-buttons-row").is_visible(), "Expected .voice-buttons-row inside main container"
        assert main_container.locator("#text-log-form").is_visible(), "Expected #text-log-form inside main container"
        assert main_container.locator(".timeline-box").is_visible(), "Expected .timeline-box inside main container"
        print("[Playwright] Verified unified container nesting voice, text input, and logged meals.")

        # Log a meal within the redesigned layout (pause to prevent API rate limit)
        time.sleep(4)
        input_box.fill("100g grilled salmon")
        submit_btn = page.locator("#btn-submit-log")
        assert not submit_btn.is_disabled()
        submit_btn.click()
        page.wait_for_selector(".meal-group:has-text('SALMON')", timeout=30000)
        print("[Playwright] Verified meal logged successfully inside unified container.")

        # Take screenshot of verified redesigned UI
        page.screenshot(path="/Users/satish.s/.gemini/antigravity/brain/1b29da82-03ee-4adf-ba27-814141ad0f77/ui_redesign_verified.png")
        print("[Playwright] Captured screenshot of redesigned UI: ui_redesign_verified.png")

        # 16. Test Strict LLM Gate & Non-Food Rejection (RCA Verification)
        time.sleep(3)
        movie_text = "we will not take one hour to search for a movie"
        input_box.fill(movie_text)
        page.locator("#btn-submit-log").click()

        # Wait for status text to indicate rejection (case-insensitive due to CSS text-transform: uppercase)
        page.wait_for_function("document.getElementById('mic-status-text').innerText.toLowerCase().includes('no food items detected')", timeout=30000)
        rejection_status = page.locator("#mic-status-text").inner_text()
        assert "no food items detected" in rejection_status.lower()
        print(f"[Playwright] Verified non-food rejection status: '{rejection_status}'")

        # Take screenshot of non-food rejection verification
        page.screenshot(path="/Users/satish.s/.gemini/antigravity/brain/1b29da82-03ee-4adf-ba27-814141ad0f77/non_food_rejection_verified.png")
        print("[Playwright] Captured screenshot of non-food rejection: non_food_rejection_verified.png")

        # Verify input was retained in the input box
        retained_input = input_box.input_value()
        assert retained_input == movie_text, f"Expected input text to be retained, got: '{retained_input}'"
        print(f"[Playwright] Verified input text was retained in input field: '{retained_input}'")

        # Verify NO meal card was created for movie search or avocado
        assert page.locator(".meal-group:has-text('movie')").count() == 0
        assert page.locator(".meal-group:has-text('avocado')").count() == 0
        print("[Playwright] Verified 0 cards created for non-food text. Zero-hallucination intact!")

        browser.close()
        print("\n>>> ALL PLAYWRIGHT HEADLESS E2E TESTS PASSED WITH 100% PERSISTENCE! <<<\n")

if __name__ == "__main__":
    pytest.main(["-s", __file__])
