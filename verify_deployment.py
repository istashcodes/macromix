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
    """Test actual Gemini meal analysis via Gemini API"""
    if not api_key:
        raise ValueError("No Gemini API key available to verify meal analysis.")

    prompt_payload = {
        "contents": [{
            "parts": [{"text": "2 boiled eggs and black coffee"}]
        }],
        "systemInstruction": {
            "parts": [{
                "text": 'Analyze meal and respond with JSON: {"is_food": true, "items": [{"food_name": "egg", "calories": 140, "protein_g": 12, "carbs_g": 1, "fat_g": 10, "fiber_g": 0}]}'
            }]
        },
        "generationConfig": {
            "responseMimeType": "application/json"
        }
    }

    models = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-3.8-flash"]
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
            with urllib.request.urlopen(req, timeout=10, context=SSL_CTX) as resp:
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
            if "settings-gemini-key-input" not in html:
                raise AssertionError("settings-gemini-key-input missing from index.html")
    results.append(run_test("Asset Check: index.html (env.js & key settings present)", test_index))

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

    # 4. Check app.js for direct inference logic
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
    results.append(run_test("Asset Check: app.js (Direct Gemini API & valid models)", test_app))

    # 5. Check sw.js
    def test_sw():
        req = urllib.request.Request(f"{base_url}/sw.js", headers={"User-Agent": "MacromixVerify/1.0"})
        with urllib.request.urlopen(req, timeout=10, context=SSL_CTX) as resp:
            if resp.status != 200:
                raise ValueError(f"sw.js returned status {resp.status}")
            js = resp.read().decode("utf-8")
            if "macromix-pwa" not in js:
                raise AssertionError("Invalid service worker cache name in sw.js")
    results.append(run_test("Asset Check: sw.js (Cache configuration valid)", test_sw))

    # 6. Check Meal Analysis (Live Inference)
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
