"""
End-to-End Automated QA Verification for WebAuthn Passkey Registration and Login.
Simulates a real browser with a virtual biometric authenticator (CTAP2) via Playwright & Chrome DevTools Protocol.
"""
import time
import pytest
from playwright.sync_api import sync_playwright
from backend.database import get_db_connection

BASE_URL = "http://localhost:8000"

def test_passkey_onboarding_and_registration():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()

        # Attach CDP Virtual Authenticator
        cdp = context.new_cdp_session(page)
        cdp.send("WebAuthn.enable")
        auth = cdp.send("WebAuthn.addVirtualAuthenticator", {
            "options": {
                "protocol": "ctap2",
                "transport": "internal",
                "hasResidentKey": True,
                "hasUserVerification": True,
                "isUserVerified": True
            }
        })
        auth_id = auth["authenticatorId"]
        print(f"[QA Agent] Virtual Authenticator active with ID: {auth_id}")

        page.goto(BASE_URL)
        page.wait_for_timeout(1000)

        # Clear existing session
        page.evaluate('localStorage.removeItem("macromix_user_handle")')
        page.reload()
        page.wait_for_timeout(1000)

        # Unique handle for this test run
        timestamp_handle = f"qa_{int(time.time())}"[-12:]
        print(f"[QA Agent] Testing passkey registration for handle: @{timestamp_handle}")

        # Fill handle
        handle_input = page.locator("#onboarding-handle-input")
        assert handle_input.is_visible(), "Expected onboarding handle input to be visible"
        handle_input.fill(timestamp_handle)

        # Click Continue with Passkey
        btn = page.locator("#btn-onboard-passkey")
        assert btn.is_visible(), "Expected passkey registration button to be visible"
        btn.click()

        # Wait for WebAuthn ceremony to complete
        page.wait_for_timeout(3500)

        # Verify onboarding is dismissed
        onboarding_screen = page.locator("#onboarding-screen")
        is_hidden = onboarding_screen.evaluate('el => el.classList.contains("hidden")')
        assert is_hidden, "Expected onboarding screen to be dismissed after passkey registration"

        # Verify header reflects handle
        header_text = page.locator("#header-handle-text").text_content()
        assert timestamp_handle in header_text, f"Expected header text to contain {timestamp_handle}, got {header_text}"
        print(f"[QA Agent] User successfully onboarded! Header displays: @{header_text}")

        # Verify credential in virtual authenticator
        creds = cdp.send("WebAuthn.getCredentials", {"authenticatorId": auth_id})
        credentials = creds.get("credentials", [])
        assert len(credentials) >= 1, "Expected at least 1 credential inside the Virtual Authenticator"
        created_cred = credentials[0]
        print(f"[QA Agent] Verified Virtual Authenticator has credential: {created_cred['credentialId']}")

        # Verify credential in local SQLite DB
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM user_credentials WHERE handle = ?", (timestamp_handle,))
        row = cursor.fetchone()
        conn.close()

        assert row is not None, f"Expected credential in user_credentials table for handle @{timestamp_handle}"
        print(f"[QA Agent] Verified SQLite DB has saved credential record with ID #{row['id']} for @{timestamp_handle}")

        browser.close()
        print("[QA Agent] PASSED: WebAuthn passkey registration verified end-to-end!")

if __name__ == "__main__":
    test_passkey_onboarding_and_registration()
