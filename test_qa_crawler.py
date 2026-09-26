import os
import time
import pytest
from playwright.sync_api import sync_playwright

from test_e2e import app_server, BASE_URL, PORT

OUTPUT_DIR = "/Users/satish.s/.gemini/antigravity/brain/dac81e5b-92a3-4e3c-a420-63fee2dd0b68/scratch/screenshots"

def test_screenshot_crawler(app_server):
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(has_touch=True, viewport={'width': 375, 'height': 812})
        page = context.new_page()

        page.goto(BASE_URL)
        page.wait_for_selector("#onboarding-screen")
        page.screenshot(path=f"{OUTPUT_DIR}/01_onboarding.png")

        test_handle = "qa_user"
        page.locator("#onboarding-handle-input").fill(test_handle)
        page.locator("#btn-onboard-passkey").click()

        page.wait_for_selector("#onboarding-screen", state="hidden", timeout=10000)
        page.wait_for_selector(".brand-title")
        time.sleep(1)
        page.screenshot(path=f"{OUTPUT_DIR}/02_home_empty.png")

        # Try to log a meal
        page.locator("#manual-text-input").fill("chicken biriyani")
        page.locator("#btn-submit-log").click()
        
        # Wait for meal to be logged or up to 25s
        try:
            page.wait_for_selector(".meal-item-row", timeout=25000)
        except Exception:
            pass
        time.sleep(1)
        page.screenshot(path=f"{OUTPUT_DIR}/03_home_after_log_attempt.png")

        # Daily Targets Modal
        page.locator("#header-handle-badge").click()
        try:
            page.wait_for_selector("#settings-modal:not(.hidden)", timeout=5000)
            time.sleep(1)
            page.screenshot(path=f"{OUTPUT_DIR}/04_daily_targets_modal.png")
            page.locator("#settings-modal .close-btn").click()
        except:
            pass

        # Date Navigation
        try:
            page.locator("#btn-date-prev").click()
            time.sleep(1)
            page.screenshot(path=f"{OUTPUT_DIR}/05_yesterday_empty.png")
        except:
            pass
        
        browser.close()
