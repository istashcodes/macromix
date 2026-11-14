import time
import pytest
from playwright.sync_api import sync_playwright

BASE_URL = "http://localhost:8000"

def test_wrapped_24h_retention():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()

        page.goto(BASE_URL)
        page.wait_for_timeout(1000)

        # 1. Test unwatched state for @istashmacros
        page.evaluate("""() => {
            localStorage.setItem('macromix_user_handle', 'istashmacros');
            localStorage.removeItem('macromix_wrapped_viewed_istashmacros_2026_w45_nov');
            localStorage.removeItem('macromix_wrapped_viewed_at_istashmacros_2026_w45_nov');
            const onb = document.getElementById('onboarding-screen');
            if (onb) onb.classList.add('hidden');
            window.syncWeekendReviewViewedState({ weekendReviewViewed: false }, 'istashmacros');
        }""")

        is_eligible = page.evaluate("() => window.isWeekendWrappedEligible()")
        has_class = page.evaluate("() => document.getElementById('brand-wrapper').classList.contains('has-wrapped-story')")
        assert is_eligible is True, "Unwatched reel must be eligible"
        assert has_class is True, "Brand logo must have glowing ring for unwatched reel"

        # 2. Open reel, watch and close
        page.evaluate("() => window.openWeeklyWrappedModal('istashmacros')")
        modal_visible = page.evaluate("() => !document.getElementById('weekly-wrapped-modal').classList.contains('hidden')")
        assert modal_visible is True, "Weekly wrapped modal should be open"

        # Advance to slide 1 (user watching the reel)
        page.wait_for_timeout(100)
        page.evaluate("() => window.markWeekendWrappedViewed('istashmacros')")

        # Close modal
        page.evaluate("() => window.closeWeeklyWrappedModal()")
        modal_hidden = page.evaluate("() => document.getElementById('weekly-wrapped-modal').classList.contains('hidden')")
        assert modal_hidden is True, "Modal should be hidden after closing"

        # Verify viewed flag and timestamp were created
        has_viewed = page.evaluate("() => window.hasUserViewedWeekendWrapped('istashmacros')")
        viewed_at = page.evaluate("() => window.getWeekendWrappedViewedAt('istashmacros')")
        assert has_viewed is True, "Should be marked viewed"
        assert viewed_at is not None and viewed_at > 0, "ViewedAt timestamp must be recorded"

        # 3. CRITICAL REQUIREMENT: After watching, glowing ring must REMAIN for 24 hours!
        is_eligible_after_watch = page.evaluate("() => window.isWeekendWrappedEligible()")
        has_class_after_watch = page.evaluate("() => document.getElementById('brand-wrapper').classList.contains('has-wrapped-story')")
        assert is_eligible_after_watch is True, "Reel must remain eligible within 24h of watch"
        assert has_class_after_watch is True, "Glowing ring MUST remain visible after watching"

        # Verify user can rewatch it by clicking brand wrapper
        page.click("#brand-wrapper")
        modal_reopened = page.evaluate("() => !document.getElementById('weekly-wrapped-modal').classList.contains('hidden')")
        assert modal_reopened is True, "User must be able to rewatch the reel"

        page.evaluate("() => window.closeWeeklyWrappedModal()")

        # 4. Test expiration after 24 hours
        page.evaluate("""() => {
            // Set timestamp to 25 hours ago
            const twentyFiveHoursAgo = Date.now() - (25 * 60 * 60 * 1000);
            localStorage.setItem('macromix_wrapped_viewed_at_istashmacros_2026_w45_nov', String(twentyFiveHoursAgo));
            window.syncWeekendReviewViewedState({
                weekendReviewViewed: true,
                weekendReviewViewedAt: twentyFiveHoursAgo
            }, 'istashmacros');
        }""")

        is_eligible_expired = page.evaluate("() => window.isWeekendWrappedEligible()")
        has_class_expired = page.evaluate("() => document.getElementById('brand-wrapper').classList.contains('has-wrapped-story')")
        assert is_eligible_expired is False, "Reel must NOT be eligible after 24 hours have passed"
        assert has_class_expired is False, "Glowing ring must disappear after 24 hours"

        # 5. Test @kalay works identically
        page.evaluate("""() => {
            localStorage.setItem('macromix_user_handle', 'kalay');
            window.syncWeekendReviewViewedState({ weekendReviewViewed: false }, 'kalay');
        }""")
        is_kalay_eligible = page.evaluate("() => window.isWeekendWrappedEligible()")
        assert is_kalay_eligible is True, "Kalay must be eligible when unwatched"

        # 6. Test other handles are NOT eligible
        page.evaluate("""() => {
            localStorage.setItem('macromix_user_handle', 'randomuser');
            window.updateWeekendWrappedVisibility();
        }""")
        is_random_eligible = page.evaluate("() => window.isWeekendWrappedEligible()")
        assert is_random_eligible is False, "Other users must not be eligible"

        browser.close()
