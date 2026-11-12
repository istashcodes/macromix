import os
import pytest
from playwright.sync_api import sync_playwright

def test_admin_dashboard_render_and_telemetry():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(viewport={'width': 1380, 'height': 920}, device_scale_factor=2)
        page = context.new_page()

        console_errors = []
        page.on('console', lambda msg: console_errors.append(msg.text) if msg.type == 'error' else None)

        # 1. Load app as @satish
        page.goto('http://localhost:8000/index.html')
        page.evaluate('''() => {
            localStorage.setItem('macromix_user_handle', 'satish');
            localStorage.setItem('macromix_onboarded', 'true');
        }''')
        page.reload()
        page.wait_for_timeout(2500)

        # Verify settings modal shows Admin Intelligence button for @satish
        page.evaluate('openSettingsModal()')
        page.wait_for_timeout(500)
        admin_btn = page.query_selector('#btn-settings-admin')
        assert admin_btn is not None, "Admin button should exist in Settings"
        assert admin_btn.is_visible(), "Admin button should be visible for @satish"

        # 2. Click Admin Intelligence button to navigate
        admin_btn.click()
        page.wait_for_timeout(2500)

        # 3. Verify Admin Dashboard view is active
        admin_view = page.query_selector('#view-admin')
        assert admin_view is not None
        assert admin_view.is_visible()

        # Check Swiss Paper title and Admin badge
        title_text = page.text_content('.admin-header-title')
        assert 'Macromix Intelligence' in title_text
        assert 'OPS · ADMIN' in title_text

        # Verify metrics 1 to 9 are populated
        accounts_total = page.text_content('#kpi-accounts-total')
        print(f"Metric 1 Total Accounts: {accounts_total}")
        assert accounts_total != '—', "Accounts total should be populated"

        dau_count = page.text_content('#kpi-dau-count')
        wau_count = page.text_content('#kpi-wau-count')
        print(f"Metric 2 DAU/WAU: {dau_count} / {wau_count}")
        assert dau_count != '—', "DAU should be populated"

        meals_total = page.text_content('#kpi-meals-total')
        print(f"Metric 3 Meals Logged: {meals_total}")
        assert meals_total != '—', "Meals total should be populated"

        voice_pct = page.text_content('#kpi-voice-pct')
        print(f"Metric 4 Voice Ratio: {voice_pct}")
        assert voice_pct != '—%', "Voice pct should be populated"

        funnel_conv = page.text_content('#funnel-conversion-rate')
        print(f"Metric 5 Funnel Conversion: {funnel_conv}")
        assert funnel_conv != '—% End-to-End', "Funnel rate should be populated"

        streak_tier0 = page.text_content('#streak-tier-0')
        print(f"Metric 6 Streak Tier 0: {streak_tier0}")
        assert streak_tier0 != '—', "Streak tier should be populated"

        # Check histogram bars rendered (24 bars)
        hist_cols = page.query_selector_all('.admin-hist-col')
        print(f"Metric 7 Histogram Bars Count: {len(hist_cols)}")
        assert len(hist_cols) == 24, "Should render 24 hourly bars"

        pwa_count = page.text_content('#infra-pwa-count')
        push_count = page.text_content('#infra-push-count')
        print(f"Metric 8 PWA / Push: {pwa_count} / {push_count}")
        assert pwa_count != '—', "PWA count should be populated"

        gemini_p = page.text_content('#infra-gemini-percentiles')
        print(f"Metric 9 Gemini Health: {gemini_p}")
        assert 'P50' in gemini_p

        # 4. Take retina screenshot of the real rendered dashboard
        out_screenshot = '/Users/satish.s/.gemini/antigravity/brain/1b29da82-03ee-4adf-ba27-814141ad0f77/admin_live_swiss_paper.png'
        page.screenshot(path=out_screenshot, full_page=True)
        print(f"Captured live dashboard screenshot: {out_screenshot}")

        # 5. Test Return to Tracker button
        back_btn = page.query_selector('#btn-admin-return-app')
        assert back_btn is not None
        back_btn.click()
        page.wait_for_timeout(1000)

        # Check view-me is back visible
        view_me = page.query_selector('#view-me')
        assert view_me.is_visible(), "Tracker view should be restored"
        assert not admin_view.is_visible(), "Admin view should be hidden"

        browser.close()

def test_admin_direct_hash_istashmacros():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(viewport={'width': 1380, 'height': 920})
        page = context.new_page()

        # Set user as istashmacros
        page.goto('http://localhost:8000/index.html')
        page.evaluate('''() => {
            localStorage.setItem('macromix_user_handle', 'istashmacros');
            localStorage.setItem('macromix_onboarded', 'true');
        }''')

        # Direct navigation to #admin
        page.goto('http://localhost:8000/index.html#admin')
        page.wait_for_timeout(2500)

        admin_view = page.query_selector('#view-admin')
        assert admin_view is not None
        assert admin_view.is_visible(), "Admin view should be visible on #admin route for istashmacros"

        view_me = page.query_selector('#view-me')
        assert not view_me.is_visible(), "Tracker view should be hidden"

        # Check admin user pill displays @istashmacros
        admin_subline = page.text_content('.admin-subline')
        assert '@istashmacros' in admin_subline, f"Subline should show @istashmacros, got: {admin_subline}"

        # Verify settings modal also shows Admin Intelligence button for istashmacros
        # First return to tracker
        page.query_selector('#btn-admin-return-app').click()
        page.wait_for_timeout(1000)
        assert page.query_selector('#view-me').is_visible()

        page.evaluate('openSettingsModal()')
        page.wait_for_timeout(500)
        admin_btn = page.query_selector('#btn-settings-admin')
        assert admin_btn is not None
        assert admin_btn.is_visible(), "Settings admin button should be visible for istashmacros"

        browser.close()

def test_admin_direct_hash_unauthenticated():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(viewport={'width': 1380, 'height': 920})
        page = context.new_page()

        # Clear any storage
        page.goto('http://localhost:8000/index.html')
        page.evaluate('''() => {
            localStorage.clear();
            sessionStorage.clear();
        }''')

        # Direct navigation to #admin
        page.goto('http://localhost:8000/index.html#admin')
        page.wait_for_timeout(2500)

        # Onboarding should NOT block admin
        onboarding = page.query_selector('#onboarding-screen')
        assert not onboarding.is_visible(), "Onboarding modal should not block #admin view"

        admin_view = page.query_selector('#view-admin')
        assert admin_view is not None
        assert admin_view.is_visible(), "Admin view should be visible to direct #admin visitor"

        browser.close()

if __name__ == '__main__':
    test_admin_dashboard_render_and_telemetry()
    test_admin_direct_hash_istashmacros()
    test_admin_direct_hash_unauthenticated()
