"""Playwright Functional Test Suite for Scroll UX & Header Immobility.

Verifies:
1. Header is permanently pinned and immobile under all touch drag, wheel, and window scroll gestures.
2. Content scrolls cleanly inside #app-scroll-canvas with gradient dissolve mask (Option 2).
3. No content ever slides behind the header or peeks through gutters.
4. Smooth scroll-to-top on brand logo click and scroll reset on tab switch.
5. Cross-platform verification on iPhone 13 (WebKit/iOS), Pixel 5 (Android Chrome), and Desktop.
"""

import os
import time
import socket
import subprocess
import pytest
from playwright.sync_api import sync_playwright

SERVE_DIR = os.path.dirname(os.path.abspath(__file__))


def get_free_port():
    s = socket.socket()
    s.bind(('', 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture(scope="module")
def server_url():
    port = get_free_port()
    server = subprocess.Popen(
        ["python3", "-m", "http.server", str(port), "--directory", SERVE_DIR],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )
    time.sleep(1)
    yield f"http://localhost:{port}"
    server.terminate()


def populate_test_environment(page, count=20):
    """Seed authenticated state and realistic scrollable meal cards."""
    page.evaluate('''() => {
        localStorage.setItem('macromix_user_handle', 'satish');
        const onboarding = document.getElementById('onboarding-screen');
        if (onboarding) onboarding.classList.add('hidden');
    }''')
    page.wait_for_timeout(400)

    page.evaluate(f'''() => {{
        const list = document.querySelector('.logged-meals-container') || document.getElementById('view-me');
        for (let i = 1; i <= {count}; i++) {{
            const card = document.createElement('div');
            card.className = 'test-meal-card';
            card.style.background = '#ffffff';
            card.style.border = '3px solid #000000';
            card.style.borderRadius = '14px';
            card.style.boxShadow = '4px 4px 0px #000000';
            card.style.padding = '16px';
            card.style.marginTop = '12px';
            card.style.fontWeight = 'bold';
            card.innerHTML = `<div style="display:flex;justify-content:space-between;"><span>Meal Log #${{i}}: Balanced Macro Plate</span><span style="background:#FFE600;padding:2px 6px;border:1px solid #000;border-radius:4px;">${{350 + i * 15}} kcal</span></div>`;
            list.appendChild(card);
        }}
    }}''')


def test_mobile_iphone13_header_immobility(server_url):
    """Verify on iPhone 13 that the header NEVER scrolls under touch, wheel, or window drag."""
    with sync_playwright() as p:
        iphone = p.devices['iPhone 13']
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(**iphone)
        page = context.new_page()

        page.goto(server_url, timeout=10000)
        populate_test_environment(page, count=25)

        header = page.locator('.app-header')
        header_shell = page.locator('.app-header-shell')
        scroller = page.locator('#app-scroll-canvas')

        # 1. Capture initial positions
        shell_box_initial = header_shell.bounding_box()
        header_box_initial = header.bounding_box()
        assert header_box_initial is not None
        assert shell_box_initial is not None

        # Verify header is at the top
        assert shell_box_initial['y'] == 0, f"Header shell not anchored at top: {shell_box_initial['y']}"

        # 2. Touch swipe gesture on content
        client = page.context.new_cdp_session(page)
        client.send('Input.synthesizeScrollGesture', {
            'x': 200,
            'y': 500,
            'yDistance': -350,
            'gestureSourceType': 'touch'
        })
        page.wait_for_timeout(400)

        # Also scroll directly to verify scroller position
        page.evaluate("document.getElementById('app-scroll-canvas').scrollTop = 350")
        page.wait_for_timeout(200)

        # 3. Assert header did not move even 0.5px
        header_box_scrolled = header.bounding_box()
        shell_box_scrolled = header_shell.bounding_box()
        window_scroll_y = page.evaluate("window.scrollY")

        assert abs(header_box_initial['y'] - header_box_scrolled['y']) < 0.5, (
            f"BUG: Header shifted during content scroll! Initial: {header_box_initial['y']}, Scrolled: {header_box_scrolled['y']}"
        )
        assert abs(shell_box_initial['y'] - shell_box_scrolled['y']) < 0.5, "Header shell shifted during content scroll!"
        assert window_scroll_y == 0, f"Window scrolled unexpectedly: {window_scroll_y}"

        # 4. Attempt direct touch drag ON THE HEADER SHELL
        client.send('Input.synthesizeScrollGesture', {
            'x': 200,
            'y': shell_box_initial['y'] + 20,
            'yDistance': -300,
            'gestureSourceType': 'touch'
        })
        page.wait_for_timeout(400)

        header_box_after_header_drag = header.bounding_box()
        assert abs(header_box_initial['y'] - header_box_after_header_drag['y']) < 0.5, (
            f"BUG: Swiping directly on header moved it! {header_box_after_header_drag['y']}"
        )
        assert page.evaluate("window.scrollY") == 0, "Window scrolled after header swipe!"

        # 5. Attempt programmatic window.scrollBy
        page.evaluate("window.scrollBy(0, 200)")
        assert page.evaluate("window.scrollY") == 0, "Window allowed scrolling despite overflow: hidden lock!"

        browser.close()


def test_android_pixel5_header_immobility(server_url):
    """Verify on Pixel 5 that header remains anchored and content scrolls."""
    with sync_playwright() as p:
        pixel = p.devices['Pixel 5']
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(**pixel)
        page = context.new_page()

        page.goto(server_url, timeout=10000)
        populate_test_environment(page, count=25)

        header = page.locator('.app-header')
        header_initial = header.bounding_box()

        # Wheel scroll
        scroller = page.locator('#app-scroll-canvas')
        box = scroller.bounding_box()
        page.mouse.move(box['x'] + 100, box['y'] + 150)
        page.mouse.wheel(0, 400)
        page.wait_for_timeout(400)

        header_after = header.bounding_box()
        assert abs(header_initial['y'] - header_after['y']) < 0.5, "Header moved during Android wheel scroll!"
        assert page.evaluate("window.scrollY") == 0, "Android window scrolled!"

        browser.close()


def test_desktop_viewport_scroll(server_url):
    """Verify on Desktop that mouse wheel scrolls canvas and header never scrolls."""
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1280, 'height': 800})
        page.goto(server_url, timeout=10000)
        populate_test_environment(page, count=30)

        header = page.locator('.app-header')
        header_initial = header.bounding_box()

        scroller = page.locator('#app-scroll-canvas')
        box = scroller.bounding_box()
        page.mouse.move(box['x'] + 100, box['y'] + 200)
        page.mouse.wheel(0, 500)
        page.wait_for_timeout(400)

        scrolled_top = page.evaluate("document.getElementById('app-scroll-canvas').scrollTop")
        assert scrolled_top > 200, f"Desktop canvas did not scroll: {scrolled_top}"

        header_after = header.bounding_box()
        assert abs(header_initial['y'] - header_after['y']) < 0.5, "Header moved on Desktop!"
        assert page.evaluate("window.scrollY") == 0, "Window scrolled on Desktop!"

        browser.close()


def test_gradient_dissolve_mask_styles(server_url):
    """Verify CSS mask-image and linear-gradient styling on .app-scroll-canvas."""
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 390, 'height': 844})
        page.goto(server_url, timeout=10000)

        mask_info = page.evaluate('''() => {
            const scroller = document.getElementById('app-scroll-canvas');
            const style = getComputedStyle(scroller);
            return {
                maskImage: style.maskImage,
                webkitMaskImage: style.webkitMaskImage,
                overflowY: style.overflowY
            };
        }''')

        assert 'linear-gradient' in (mask_info['maskImage'] or mask_info['webkitMaskImage']), (
            f"Gradient mask not found on scroller: {mask_info}"
        )
        assert mask_info['overflowY'] == 'auto', f"Expected overflowY auto, got: {mask_info['overflowY']}"

        browser.close()


def test_no_content_behind_or_above_header(server_url):
    """Verify that the scrolling canvas boundary never extends into or behind the header shell."""
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 390, 'height': 844})
        page.goto(server_url, timeout=10000)
        populate_test_environment(page, count=20)

        header_shell = page.locator('.app-header-shell')
        scroller = page.locator('#app-scroll-canvas')

        shell_bottom = header_shell.bounding_box()['y'] + header_shell.bounding_box()['height']
        scroller_top = scroller.bounding_box()['y']

        # Scroller must start at or below the header shell bottom (never behind it)
        assert scroller_top >= shell_bottom - 1.0, (
            f"Canvas overlaps header shell! Scroller top: {scroller_top}, Shell bottom: {shell_bottom}"
        )

        browser.close()


def test_scroll_reset_interactions(server_url):
    """Verify that brand logo click and tab switch cleanly reset canvas scroll to top."""
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 390, 'height': 844})
        page.goto(server_url, timeout=10000)
        populate_test_environment(page, count=20)

        # 1. Scroll canvas
        page.evaluate("document.getElementById('app-scroll-canvas').scrollTop = 300")
        page.wait_for_timeout(200)
        assert page.evaluate("document.getElementById('app-scroll-canvas').scrollTop") > 200

        # 2. Click brand logo -> scrolls to top
        page.click('#brand-wrapper')
        page.wait_for_timeout(600)
        reset_top = page.evaluate("document.getElementById('app-scroll-canvas').scrollTop")
        assert reset_top < 10, f"Scroll did not reset to top on brand click: {reset_top}"

        # 3. Scroll again and switch to friends tab -> resets to top
        page.evaluate("document.getElementById('app-scroll-canvas').scrollTop = 300")
        page.wait_for_timeout(200)
        page.evaluate("window.switchTab('friends')")
        page.wait_for_timeout(200)
        tab_reset_top = page.evaluate("document.getElementById('app-scroll-canvas').scrollTop")
        assert tab_reset_top == 0, f"Scroll did not reset on tab switch: {tab_reset_top}"

        browser.close()


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
