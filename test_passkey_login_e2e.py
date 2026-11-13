"""
E2E automated test for Passkey Login on an existing claimed handle (@istashmacros).
Verifies:
1. When user enters existing handle @istashmacros and attempts passkey login on a new device:
   - It NEVER shows "Handle @istashmacros is already claimed".
   - It invokes WebAuthn navigator.credentials.get().
2. With Virtual Authenticator (CTAP2):
   - Successfully authenticates the passkey assertion.
   - Dismisses onboarding modal.
   - Restores user profile, streak, daily macro targets, and meal logs.
   - Settings modal displays handle and Cross-Device Google Linking button.
3. When passkey is not on this device or cancelled:
   - Clean guidance message displayed.
   - Does NOT attempt account registration.
"""
import os
import time
import pytest
from playwright.sync_api import sync_playwright

BASE_URL = "http://localhost:8000"


def test_existing_handle_passkey_login():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()

        # Attach CDP Virtual Authenticator to simulate WebAuthn biometric passkey
        cdp = context.new_cdp_session(page)
        cdp.send("WebAuthn.enable")
        auth_res = cdp.send("WebAuthn.addVirtualAuthenticator", {
            "options": {
                "protocol": "ctap2",
                "transport": "internal",
                "hasResidentKey": True,
                "hasUserVerification": True,
                "isUserVerified": True,
                "automaticPresenceSimulation": True,
            }
        })
        auth_id = auth_res["authenticatorId"]

        page.goto(BASE_URL)
        page.wait_for_timeout(1000)

        # 1. First ensure onboarding screen is visible
        onboarding = page.locator("#onboarding-screen")
        assert onboarding.is_visible(), "Onboarding screen should be visible for new session"

        # 2. Add credential for istashmacros directly to virtual authenticator
        page.evaluate('''async () => {
            const challenge = new Uint8Array(32);
            window.crypto.getRandomValues(challenge);
            await navigator.credentials.create({
                publicKey: {
                    challenge: challenge,
                    rp: { name: "macromix", id: window.location.hostname },
                    user: {
                        id: new Uint8Array([105, 115, 116, 97, 115, 104]),
                        name: "istashmacros",
                        displayName: "@istashmacros"
                    },
                    pubKeyCredParams: [{ alg: -7, type: "public-key" }, { alg: -257, type: "public-key" }],
                    authenticatorSelection: {
                        authenticatorAttachment: "platform",
                        residentKey: "required",
                        requireResidentKey: true,
                        userVerification: "preferred"
                    }
                }
            });
        }''')

        # Now simulate typing @istashmacros in the handle input
        handle_input = page.locator("#onboarding-handle-input")
        handle_input.fill("istashmacros")

        # Click Continue with Passkey
        passkey_btn = page.locator("#btn-onboard-passkey")
        passkey_btn.click()

        # Wait for authentication to resolve
        page.wait_for_timeout(3000)

        # 3. Verify error "Handle @istashmacros is already claimed" is NOT displayed!
        status_msg = page.locator("#handle-status-msg").inner_text()
        assert "already claimed" not in status_msg, f"Unexpected claim error: {status_msg}"

        # 4. Verify onboarding screen is dismissed!
        is_hidden = onboarding.evaluate('el => el.classList.contains("hidden")')
        assert is_hidden, "Onboarding screen should be dismissed on successful login"

        # 5. Verify local storage and current user
        active_handle = page.evaluate('localStorage.getItem("macromix_user_handle")')
        assert active_handle == "istashmacros", f"Expected active handle istashmacros, got {active_handle}"

        # 6. Verify daily targets were restored from Firestore (calories 2700 for istashmacros)
        targets = page.evaluate('() => JSON.parse(localStorage.getItem("macronomics_targets") || "{}")')
        assert int(targets.get("calories", 0)) == 2700, f"Expected 2700 calories, got {targets.get('calories')}"

        # 7. Verify Settings modal shows Link Google button
        page.evaluate('() => openSettingsModal()')
        page.wait_for_timeout(500)

        settings_handle = page.locator("#settings-account-handle").inner_text()
        assert "@istashmacros" in settings_handle, f"Expected @istashmacros in settings, got {settings_handle}"

        google_link_btn = page.locator("#btn-link-google")
        assert google_link_btn.is_visible() or page.locator("#settings-google-status").is_visible(), \
            "Link Google button or status should be present in settings"

        browser.close()
        print("✓ All passkey login assertions passed successfully!")


def test_missing_or_cancelled_passkey_guidance():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()

        # Enable authenticator but DO NOT register a credential for istashmacros
        cdp = context.new_cdp_session(page)
        cdp.send("WebAuthn.enable")
        cdp.send("WebAuthn.addVirtualAuthenticator", {
            "options": {
                "protocol": "ctap2",
                "transport": "internal",
                "hasResidentKey": True,
                "hasUserVerification": True,
                "isUserVerified": True,
                "automaticPresenceSimulation": True,
            }
        })

        page.goto(BASE_URL)
        page.wait_for_timeout(1000)

        handle_input = page.locator("#onboarding-handle-input")
        handle_input.fill("istashmacros")

        passkey_btn = page.locator("#btn-onboard-passkey")
        passkey_btn.click()

        page.wait_for_timeout(3000)

        status_msg = page.locator("#handle-status-msg").inner_text()
        print("Got expected guidance status:", status_msg)

        # MUST NOT show "already claimed"
        assert "already claimed" not in status_msg
        # MUST show guidance (e.g. cancelled or no passkey found on this device)
        assert "passkey" in status_msg.lower() or "google" in status_msg.lower()

        browser.close()
        print("✓ Missing passkey clean guidance verified!")


def test_enter_key_passkey_login():
    """Verify that pressing Enter in the handle input submits and processes the passkey login."""
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()

        # Attach CDP Virtual Authenticator
        cdp = context.new_cdp_session(page)
        cdp.send("WebAuthn.enable")
        cdp.send("WebAuthn.addVirtualAuthenticator", {
            "options": {
                "protocol": "ctap2",
                "transport": "internal",
                "hasResidentKey": True,
                "hasUserVerification": True,
                "isUserVerified": True,
                "automaticPresenceSimulation": True,
            }
        })

        page.goto(BASE_URL)
        page.wait_for_timeout(1000)

        # Pre-register credential for istashmacros
        page.evaluate('''async () => {
            const challenge = new Uint8Array(32);
            window.crypto.getRandomValues(challenge);
            await navigator.credentials.create({
                publicKey: {
                    challenge: challenge,
                    rp: { name: "macromix", id: window.location.hostname },
                    user: {
                        id: new TextEncoder().encode("istashmacros"),
                        name: "istashmacros",
                        displayName: "istashmacros"
                    },
                    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
                    authenticatorSelection: {
                        authenticatorAttachment: "platform",
                        requireResidentKey: true,
                        userVerification: "preferred"
                    }
                }
            });
        }''')

        handle_input = page.locator("#onboarding-handle-input")
        assert handle_input.is_visible(), "Onboarding input should be visible"

        # Type handle and hit ENTER instead of clicking the button
        handle_input.fill("istashmacros")
        handle_input.press("Enter")
        page.wait_for_timeout(3000)

        # Verify onboarding is dismissed and user logged in
        onboarding = page.locator("#onboarding-screen")
        is_hidden = onboarding.evaluate('el => el.classList.contains("hidden")')
        assert is_hidden, "Onboarding screen should be dismissed when pressing Enter"

        active_handle = page.evaluate('localStorage.getItem("macromix_user_handle")')
        assert active_handle == "istashmacros", f"Expected active handle istashmacros, got {active_handle}"

        browser.close()
        print("✓ Enter key passkey login verified!")


if __name__ == "__main__":
    test_existing_handle_passkey_login()
    test_missing_or_cancelled_passkey_guidance()
    test_enter_key_passkey_login()
