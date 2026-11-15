import json
from playwright.sync_api import sync_playwright

BASE_URL = "http://localhost:8000"

def test_processing_skeleton_and_button_animation():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()

        page.goto(BASE_URL)
        page.wait_for_timeout(1000)

        # Setup user and dismiss onboarding
        page.evaluate("""() => {
            localStorage.setItem('macromix_user_handle', 'istashmacros');
            const onb = document.getElementById('onboarding-screen');
            if (onb) onb.classList.add('hidden');
        }""")
        page.wait_for_timeout(500)

        # Verify initial button state
        btn_track = page.locator("#btn-tap-record")
        assert btn_track.is_visible()
        btn_text = btn_track.inner_text()
        assert "Track your macromix" in btn_text
        assert "processing" not in (btn_track.get_attribute("class") or "")

        # 1. Test unit functions for showProcessingMealSkeleton in 'listening' state
        page.evaluate("""() => {
            window.showProcessingMealSkeleton('listening');
        }""")
        page.wait_for_timeout(300)

        skel = page.locator("#processing-meal-skeleton")
        assert skel.is_visible()
        assert "is-listening" in (skel.get_attribute("class") or "")
        badge = skel.locator(".processing-status-pill")
        assert "badge-listening" in (badge.get_attribute("class") or "")
        assert "LISTENING" in badge.inner_text()

        # Update text during speech
        page.evaluate("""() => {
            window.updateProcessingMealSkeletonText('2 boiled eggs and butter toast');
        }""")
        preview_text = page.locator("#processing-transcript-preview").inner_text()
        assert "2 boiled eggs and butter toast" in preview_text

        # Transition to analyzing state
        page.evaluate("""() => {
            window.setTrackButtonState('processing');
            window.showProcessingMealSkeleton('analyzing', '2 boiled eggs and butter toast');
        }""")
        page.wait_for_timeout(300)

        assert "is-analyzing" in (skel.get_attribute("class") or "")
        assert "badge-analyzing" in (badge.get_attribute("class") or "")
        assert "ANALYZING WITH GEMINI" in badge.inner_text()

        # Check macro chips in skeleton
        chips = skel.locator(".processing-chip-skel")
        assert chips.count() == 4
        assert "Calories" in chips.nth(0).inner_text()
        assert "Protein" in chips.nth(1).inner_text()
        assert "Carbs" in chips.nth(2).inner_text()
        assert "Fat" in chips.nth(3).inner_text()

        # Check button processing state
        assert "processing" in (btn_track.get_attribute("class") or "")
        assert "Analyzing your macromix" in btn_track.inner_text()

        # Take screenshot of skeleton & button processing state
        page.screenshot(path="/Users/satish.s/.gemini/antigravity/brain/1b29da82-03ee-4adf-ba27-814141ad0f77/processing_state_verified.png")

        # Cleanup unit test
        page.evaluate("""() => {
            window.hideProcessingMealSkeleton();
            window.setTrackButtonState('idle');
        }""")
        page.wait_for_timeout(300)
        assert not skel.is_visible()
        assert "Track your macromix" in btn_track.inner_text()
        assert "processing" not in (btn_track.get_attribute("class") or "")

        # 2. Test full end-to-end integration via mock API
        pending_routes = []
        def handle_gemini(route):
            pending_routes.append(route)

        page.route("**/api/gemini/multimodal", handle_gemini)

        today_str = page.evaluate("() => window.getTodayDateString()")
        mock_meal = {
            "id": 9999,
            "owner_handle": "istashmacros",
            "is_food": True,
            "meal_type": "snack",
            "raw_transcript": "1 bowl greek yogurt with almonds",
            "logged_time": "10:15",
            "logged_date": today_str,
            "created_at": f"{today_str}T10:15:00.000Z",
            "total_calories": 220,
            "total_protein_g": 20,
            "total_carbs_g": 12,
            "total_fat_g": 9,
            "total_fiber_g": 2,
            "items": [
                {
                    "id": 19999,
                    "food_name": "Greek Yogurt with Almonds",
                    "quantity": 1,
                    "unit": "bowl",
                    "standardized_weight_g": 200,
                    "calories": 220,
                    "protein_g": 20,
                    "carbs_g": 12,
                    "fat_g": 9,
                    "fiber_g": 2
                }
            ]
        }

        def handle_logs(route):
            if route.request.method == 'GET':
                route.fulfill(status=200, content_type="application/json", body=json.dumps([mock_meal]))
            else:
                route.fulfill(status=200, content_type="application/json", body=json.dumps(mock_meal))

        page.route("**/api/logs*", handle_logs)

        # Type meal and submit
        input_box = page.locator("#manual-text-input")
        input_box.fill("1 bowl greek yogurt with almonds")
        submit_btn = page.locator("#btn-submit-log")
        submit_btn.click()

        # Wait for the network request to be captured
        page.wait_for_timeout(300)
        assert len(pending_routes) == 1, "Gemini route should have been called"

        # While route is pending: verify processing classes and skeleton are active in DOM!
        assert "processing" in (btn_track.get_attribute("class") or "")
        assert "Analyzing your macromix" in btn_track.inner_text()
        live_skel = page.locator("#processing-meal-skeleton")
        assert live_skel.is_visible()
        assert "1 bowl greek yogurt with almonds" in live_skel.inner_text()
        assert "ANALYZING WITH GEMINI" in live_skel.inner_text()

        # Take screenshot during active in-flight processing
        page.screenshot(path="/Users/satish.s/.gemini/antigravity/brain/1b29da82-03ee-4adf-ba27-814141ad0f77/in_flight_processing_live.png")

        # Now fulfill the pending Gemini route
        pending_routes[0].fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps(mock_meal)
        )

        # Wait for request to finish and DOM to update
        page.wait_for_timeout(1000)

        # Skeleton should be dismissed and button returned to idle
        assert not live_skel.is_visible()
        assert "Track your macromix" in btn_track.inner_text()
        assert "processing" not in (btn_track.get_attribute("class") or "")

        # Meal should appear in timeline
        meal_item = page.locator(".meal-item-title", has_text="Greek Yogurt with Almonds")
        assert meal_item.is_visible()

        page.screenshot(path="/Users/satish.s/.gemini/antigravity/brain/1b29da82-03ee-4adf-ba27-814141ad0f77/meal_resolved_after_processing.png")
        print("✓ All processing skeleton and animation tests passed!")
        browser.close()

if __name__ == "__main__":
    test_processing_skeleton_and_button_animation()
