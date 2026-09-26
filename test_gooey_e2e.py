import time
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 390, 'height': 844})
    
    # Track any console errors
    errors = []
    page.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' else None)

    # Set up user handle
    page.goto('http://localhost:8000')
    page.evaluate('''() => {
        localStorage.setItem('macromix_user_handle', 'satish');
        location.reload();
    }''')
    page.wait_for_timeout(1000)

    # 1. State: Me is active
    page.wait_for_selector('#tab-pill-me:not([style*="display: none"])')
    page.screenshot(path='/Users/satish.s/.gemini/antigravity/brain/89d7d39b-af19-4fbb-82e5-92da7a81f593/goo_e2e_1_me_active.png')
    
    # 2. Click Friends
    page.locator('#tab-pill-friends').click()
    page.wait_for_timeout(100) # mid-flight goo stretch
    page.screenshot(path='/Users/satish.s/.gemini/antigravity/brain/89d7d39b-af19-4fbb-82e5-92da7a81f593/goo_e2e_2_midflight_to_friends.png')
    
    page.wait_for_timeout(400) # completed
    page.screenshot(path='/Users/satish.s/.gemini/antigravity/brain/89d7d39b-af19-4fbb-82e5-92da7a81f593/goo_e2e_3_friends_active.png')

    # 3. Click Me
    page.locator('#tab-pill-me').click()
    page.wait_for_timeout(100) # mid-flight goo stretch back
    page.screenshot(path='/Users/satish.s/.gemini/antigravity/brain/89d7d39b-af19-4fbb-82e5-92da7a81f593/goo_e2e_4_midflight_to_me.png')

    page.wait_for_timeout(400) # completed
    page.screenshot(path='/Users/satish.s/.gemini/antigravity/brain/89d7d39b-af19-4fbb-82e5-92da7a81f593/goo_e2e_5_me_active_again.png')

    print("Console errors:", [e for e in errors if 'favicon' not in e])
    print("E2E Gooey test completed successfully!")
    browser.close()
