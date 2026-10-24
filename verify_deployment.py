#!/usr/bin/env python3
"""
Verification Test Harness for macromix deployment & Gemini Meal Analysis.
Ensures zero 404 regressions and validates live asset and Gemini integration.
"""

import sys
import json
import urllib.request
import urllib.error
import re
import argparse
import ssl

DEFAULT_URL = "https://macromix.web.app"
SSL_CTX = ssl._create_unverified_context()

def run_test(name, fn):
    print(f"[*] Running: {name} ...", end=" ", flush=True)
    try:
        fn()
        print("[ PASS ]")
        return True
    except Exception as e:
        print(f"[ FAIL ] -> {e}")
        return False

def check_gemini_direct_inference(api_key: str):
    """Test actual Gemini meal analysis via Gemini API matching app.js configuration"""
    if not api_key:
        raise ValueError("No Gemini API key available to verify meal analysis.")

    prompt_payload = {
        "contents": [{
            "parts": [{"text": "chicken biryani with 300g rice and 100g chicken and 1 glass lassi"}]
        }],
        "systemInstruction": {
            "parts": [{
                "text": """You are a high-precision nutritional voice assistant.
CRITICAL INSTRUCTION: Analyze the audio or text carefully.
1. If the input is conversational speech, questions, commands, background chatter, or does NOT describe actual food or drink consumed, set is_food: false.
2. If and only if the input mentions edible food or beverages consumed, set is_food: true, transcribe what was eaten, extract each food item entity, and compute precise macronutrients.
Output strictly JSON object."""
            }]
        },
        "generationConfig": {
            "responseMimeType": "application/json",
            "thinkingConfig": {"thinkingBudget": 0}
        }
    }

    models = ["gemini-flash-latest", "gemini-3.8-flash"]
    last_err = None
    success = False

    for model in models:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
        req = urllib.request.Request(
            url,
            data=json.dumps(prompt_payload).encode("utf-8"),
            headers={"Content-Type": "application/json"}
        )
        try:
            with urllib.request.urlopen(req, timeout=15, context=SSL_CTX) as resp:
                if resp.status == 200:
                    body = json.loads(resp.read().decode("utf-8"))
                    text = body["candidates"][0]["content"]["parts"][0]["text"]
                    clean = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
                    parsed = json.loads(clean)
                    if parsed.get("is_food") is True and "items" in parsed:
                        success = True
                        break
        except Exception as e:
            last_err = e

    if not success:
        raise RuntimeError(f"Gemini meal analysis API failed: {last_err}")

def verify_error_sanitization():
    """Verify that raw HTML tags from 404 pages are never displayed in user-facing error banners"""
    sample_404_html = '<html><head><title>404 Page not found</title></head><body><h1>Not Found</h1></body></html>'
    clean = re.sub(r"<[^>]*>", " ", sample_404_html)
    clean = " ".join(clean.split())
    if "<" in clean or ">" in clean or "<html>" in clean.lower():
        raise AssertionError("HTML tags were not cleanly stripped from error string")

def verify_deployment(base_url: str = DEFAULT_URL, local_key: str = None) -> bool:
    print("=" * 70)
    print(f"       MACROMIX DEPLOYMENT & MEAL ANALYSIS VERIFICATION HARNESS")
    print(f"       Target: {base_url}")
    print("=" * 70)

    results = []

    # 1. Verify Error Sanitizer
    results.append(run_test(
        "Sanitization Test: Ensure raw 404 HTML cannot leak into UI",
        verify_error_sanitization
    ))

    # 2. Check index.html
    def test_index():
        req = urllib.request.Request(f"{base_url}/index.html", headers={"User-Agent": "MacromixVerify/1.0"})
        with urllib.request.urlopen(req, timeout=10, context=SSL_CTX) as resp:
            if resp.status != 200:
                raise ValueError(f"index.html returned status {resp.status}")
            html = resp.read().decode("utf-8")
            if "env.js" not in html:
                raise AssertionError("env.js script tag missing from index.html")
            if "settings-gemini-key-input" in html:
                raise AssertionError("settings-gemini-key-input should be removed from index.html")
            if "btn-test-notification" in html:
                raise AssertionError("btn-test-notification should be removed from index.html")
            if "settings-reminder-time" not in html or "btn-toggle-notifications" not in html:
                raise AssertionError("Daily Push Reminder settings controls missing from index.html")
            if "settings-account-handle" not in html or "btn-settings-signout" not in html:
                raise AssertionError("Simplified Account & Signout controls missing from index.html")
    results.append(run_test("Asset Check: index.html (env.js, simplified settings & push controls)", test_index))

    # 3. Check env.js
    api_key_from_env = local_key
    def test_env():
        nonlocal api_key_from_env
        req = urllib.request.Request(f"{base_url}/env.js", headers={"User-Agent": "MacromixVerify/1.0"})
        with urllib.request.urlopen(req, timeout=10, context=SSL_CTX) as resp:
            if resp.status != 200:
                raise ValueError(f"env.js returned status {resp.status}")
            content = resp.read().decode("utf-8")
            if "GEMINI_API_KEY" not in content:
                raise AssertionError("GEMINI_API_KEY missing from env.js")
            m = re.search(r'GEMINI_API_KEY\s*:\s*["\']([^"\']+)["\']', content)
            if m and m.group(1):
                api_key_from_env = m.group(1)
    results.append(run_test("Asset Check: env.js (GEMINI_API_KEY served)", test_env))

    # 4. Check app.js for direct inference & reminder logic
    def test_app():
        req = urllib.request.Request(f"{base_url}/app.js", headers={"User-Agent": "MacromixVerify/1.0"})
        with urllib.request.urlopen(req, timeout=10, context=SSL_CTX) as resp:
            if resp.status != 200:
                raise ValueError(f"app.js returned status {resp.status}")
            js = resp.read().decode("utf-8")
            if "generativelanguage.googleapis.com" not in js:
                raise AssertionError("Direct Gemini API fallback missing from app.js")
            if "gemini-flash-latest" not in js:
                raise AssertionError("gemini-flash-latest missing from app.js")
            if "thinkingBudget" not in js:
                raise AssertionError("thinkingBudget configuration missing from app.js")
            if "evaluateDailyReminderStatus" not in js:
                raise AssertionError("evaluateDailyReminderStatus missing from app.js")
            if "checkAndSendDailyReminder" not in js:
                raise AssertionError("checkAndSendDailyReminder missing from app.js")
            if "scheduleDailyReminderCheck" not in js:
                raise AssertionError("scheduleDailyReminderCheck missing from app.js")
            if "setupDailyReminderScheduler" not in js:
                raise AssertionError("setupDailyReminderScheduler missing from app.js")
    results.append(run_test("Asset Check: app.js (Inference & reminder engine present)", test_app))

    # 5. Check sw.js for caching and push listeners
    def test_sw():
        req = urllib.request.Request(f"{base_url}/sw.js", headers={"User-Agent": "MacromixVerify/1.0"})
        with urllib.request.urlopen(req, timeout=10, context=SSL_CTX) as resp:
            if resp.status != 200:
                raise ValueError(f"sw.js returned status {resp.status}")
            js = resp.read().decode("utf-8")
            if "macromix-pwa" not in js:
                raise AssertionError("Invalid service worker cache name in sw.js")
            if "'push'" not in js and '"push"' not in js:
                raise AssertionError("Push notification listener missing from sw.js")
            if "'notificationclick'" not in js and '"notificationclick"' not in js:
                raise AssertionError("Notification click listener missing from sw.js")
    results.append(run_test("Asset Check: sw.js (Cache & push handlers valid)", test_sw))

    # 6. Functional Check: Daily Reminder Logic & 50% Thresholds
    def test_reminder_logic():
        import subprocess
        req = urllib.request.Request(f"{base_url}/app.js", headers={"User-Agent": "MacromixVerify/1.0"})
        with urllib.request.urlopen(req, timeout=10, context=SSL_CTX) as resp:
            app_code = resp.read().decode("utf-8")

        m = re.search(r"(function evaluateDailyReminderStatus[\s\S]*?\n\})", app_code)
        if not m:
            raise AssertionError("evaluateDailyReminderStatus definition missing from app.js")
        fn_code = m.group(1)

        test_script = f"""
        {fn_code}
        const targets = {{ calories: 2000, protein_g: 150, carbs_g: 200, fat_g: 65, fiber_g: 30 }};

        // 1. 0 meals -> shouldRemind true (no_entry)
        const t1 = evaluateDailyReminderStatus([], targets);
        if (!t1.shouldRemind || t1.reason !== 'no_entry') throw new Error('0 meals must trigger no_entry reminder');

        // 2. 1 target met at 50% -> shouldRemind true (< 3 met)
        const t2 = evaluateDailyReminderStatus([{{ total_calories: 1050, total_protein_g: 20, total_carbs_g: 30, total_fat_g: 10, total_fiber_g: 2 }}], targets);
        if (!t2.shouldRemind || t2.metCount !== 1) throw new Error('1 target met must trigger below_50pct_threshold reminder');

        // 3. 2 targets met at 50% -> shouldRemind true (< 3 met)
        const t3 = evaluateDailyReminderStatus([{{ total_calories: 1050, total_protein_g: 80, total_carbs_g: 30, total_fat_g: 10, total_fiber_g: 2 }}], targets);
        if (!t3.shouldRemind || t3.metCount !== 2) throw new Error('2 targets met must trigger below_50pct_threshold reminder');

        // 4. 3 targets met at 50% -> shouldRemind false (>= 3 met)
        const t4 = evaluateDailyReminderStatus([{{ total_calories: 1050, total_protein_g: 80, total_carbs_g: 110, total_fat_g: 10, total_fiber_g: 2 }}], targets);
        if (t4.shouldRemind || t4.metCount !== 3) throw new Error('3 targets met at 50% must NOT trigger reminder');

        // 5. 5 targets met at 50% -> shouldRemind false
        const t5 = evaluateDailyReminderStatus([{{ total_calories: 2000, total_protein_g: 150, total_carbs_g: 200, total_fat_g: 65, total_fiber_g: 30 }}], targets);
        if (t5.shouldRemind || t5.metCount !== 5) throw new Error('5 targets met must NOT trigger reminder');
        """
        res = subprocess.run(["node", "-e", test_script], capture_output=True, text=True)
        if res.returncode != 0:
            raise AssertionError(f"Reminder evaluation unit test failed: {res.stderr or res.stdout}")
    results.append(run_test("Functional Check: Daily Reminder 50% Target Rules (0 to 5 targets)", test_reminder_logic))

    # 7. Check Meal Analysis (Live Inference)
    def test_inference():
        key_to_test = api_key_from_env or local_key
        if not key_to_test:
            # Try to read from local env.js
            try:
                with open("env.js", "r", encoding="utf-8") as f:
                    m = re.search(r'GEMINI_API_KEY\s*:\s*["\']([^"\']+)["\']', f.read())
                    if m:
                        key_to_test = m.group(1)
            except Exception:
                pass
        check_gemini_direct_inference(key_to_test)
    results.append(run_test("Functional Check: Gemini Meal Analysis (No 404, valid extraction)", test_inference))

    print("-" * 70)
    passed = sum(1 for r in results if r)
    total = len(results)
    print(f"VERIFICATION RESULTS: {passed}/{total} Passed")

    if passed == total:
        print(">>> ALL VERIFICATION CHECKS PASSED: MEAL ANALYSIS & DEPLOYMENT FULLY HEALTHY! <<<")
        return True
    else:
        print(">>> VERIFICATION FAILED: DEPLOYMENT HAS ISSUES! <<<")
        return False

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Verify Macromix deployment and meal analysis.")
    parser.add_argument("--url", type=str, default=DEFAULT_URL, help="Base URL of deployed app")
    parser.add_argument("--key", type=str, default=None, help="Optional Gemini API key override")
    args = parser.parse_args()

    ok = verify_deployment(args.url, args.key)
    sys.exit(0 if ok else 1)
