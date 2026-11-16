import pytest
from playwright.sync_api import sync_playwright

BASE_URL = "http://localhost:8000"

def test_unified_input_controls_in_logged_meals():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 480, "height": 880})
        page.goto(BASE_URL)
        page.wait_for_timeout(800)

        # Setup user and dismiss onboarding
        page.evaluate("""() => {
            localStorage.setItem('macromix_user_handle', 'istashmacros');
            const onb = document.getElementById('onboarding-screen');
            if (onb) onb.classList.add('hidden');
        }""")
        page.wait_for_timeout(300)

        # 1. Obsolete voice-tool-card is removed
        assert page.locator("#voice-tool-card").count() == 0, "#voice-tool-card must not be in DOM"

        # 2. Input zone is located inside #timeline-box-section
        input_zone = page.locator("#timeline-box-section #timeline-input-zone")
        assert input_zone.is_visible(), "Timeline input zone must be visible inside timeline-box-section"

        # 3. Idle CTA
        btn = page.locator("#btn-tap-record")
        assert btn.is_visible()
        assert "Track your macro" in btn.inner_text()
        assert "recording" not in (btn.get_attribute("class") or "")
        assert "processing" not in (btn.get_attribute("class") or "")

        # 4. Recording CTA: has animated bars + unified 'Listening... Tap to finish' text
        page.evaluate("() => window.setTrackButtonState('recording')")
        page.wait_for_timeout(200)
        assert "recording" in (btn.get_attribute("class") or "")
        assert "Listening... Tap to finish" in btn.inner_text()
        assert page.locator("#cta-audio-bars").is_visible()
        assert page.locator(".pulse-dot-white").is_visible()

        # 5. Processing CTA: has kinetic stripes & sparkle
        page.evaluate("() => window.setTrackButtonState('processing')")
        page.wait_for_timeout(200)
        assert "processing" in (btn.get_attribute("class") or "")
        assert "Analyzing your macro" in btn.inner_text()

        # 6. Inline error banner & manual dismiss
        page.evaluate("() => window.setTrackButtonState('idle')")
        page.evaluate("() => window.showCtaInlineError('Test Error: No food detected.')")
        page.wait_for_timeout(200)
        banner = page.locator("#error-banner")
        assert banner.is_visible()
        assert "Test Error: No food detected." in banner.inner_text()

        # Click dismiss button ✕
        page.locator("#error-dismiss-btn").click()
        page.wait_for_timeout(100)
        assert not banner.is_visible(), "Error banner must hide immediately upon dismiss click"

        # 7. Inline error auto-disappear after 5 seconds
        page.evaluate("() => window.showCtaInlineError('Auto disappear error')")
        page.wait_for_timeout(200)
        assert banner.is_visible()
        page.wait_for_timeout(5300)
        assert not banner.is_visible(), "Error banner must automatically disappear after 5 seconds"

        browser.close()
