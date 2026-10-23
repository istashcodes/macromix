#!/usr/bin/env python3
"""
gemini_coder.py - Autonomous AI Coder for macromix
Processes GitHub issues and comments via targeted search-and-replace edits.
Optimized for ultra-fast, zero-timeout execution on mobile coder tracks.
"""

import os
import sys
import json
import urllib.request
import urllib.error
import subprocess
import time
import ssl
import re

CORE_MANIFEST = {
    "index.html": "HTML5 UI structure, modals, headers, neo-brutalist buttons, SVG circles",
    "styles.css": "Neo-brutalist visual styling, themes, fonts, colors, animations, responsive layout",
    "app.js": "Core frontend controller, voice tracking, Gemini meal parsing, macro circles, tabs",
    "firebase-db.js": "Firebase Firestore sync, user handles, streak sync",
    "manifest.json": "PWA web app manifest, colors, icons, link handling",
    "sw.js": "Service worker precache & offline assets"
}

DEFAULT_MODELS = ["gemini-3.8-flash", "gemini-flash-latest"]
SSL_CTX = ssl._create_unverified_context()
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

def log(msg):
    print(f"[Gemini Coder] {msg}", flush=True)

def get_issue_info():
    event_path = os.environ.get("GITHUB_EVENT_PATH")
    if not event_path or not os.path.exists(event_path):
        log("No GITHUB_EVENT_PATH found. Running in local test mode.")
        return {
            "number": 0,
            "title": "Local Test Task",
            "body": "Test local prompt",
            "prompt": "Test local prompt",
            "author": "local_user"
        }

    with open(event_path, "r", encoding="utf-8") as f:
        event = json.load(f)

    issue = event.get("issue", {})
    comment = event.get("comment", {})

    number = issue.get("number", 0)
    title = issue.get("title", "")
    issue_body = issue.get("body", "") or ""
    issue_author = issue.get("user", {}).get("login", "")

    # If triggered by a comment (e.g. /gemini fix the button colors)
    if comment and comment.get("body"):
        raw_comment = comment.get("body", "").strip()
        cleaned_prompt = re.sub(r"^/gemini\s*", "", raw_comment, flags=re.IGNORECASE).strip()
        comment_author = comment.get("user", {}).get("login", issue_author)
        return {
            "number": number,
            "title": title,
            "body": issue_body,
            "prompt": cleaned_prompt,
            "author": comment_author,
            "is_comment": True
        }

    return {
        "number": number,
        "title": title,
        "body": issue_body,
        "prompt": f"{title}\n\n{issue_body}".strip(),
        "author": issue_author,
        "is_comment": False
    }

def call_gemini_api(api_key, payload, model_name, timeout=120):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={api_key}"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as resp:
        res = json.loads(resp.read().decode("utf-8"))
    
    text = res["candidates"][0]["content"]["parts"][0]["text"]
    clean_text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
    return json.loads(clean_text)

def select_relevant_files(api_key, issue_info):
    """Phase 1: Fast file identification so we don't bloat the prompt with 220KB of code."""
    manifest_lines = [f"- {fn}: {desc}" for fn, desc in CORE_MANIFEST.items()]
    manifest_text = "\n".join(manifest_lines)

    system_instruction = (
        "You are an AI software architect. Analyze the user request and determine which repository "
        "file(s) must be examined and edited. Respond STRICTLY with JSON: {\"files\": [\"filename1\", ...]}"
    )
    user_prompt = (
        f"ISSUE #{issue_info['number']}: {issue_info['title']}\n"
        f"USER REQUEST:\n{issue_info['prompt']}\n\n"
        f"AVAILABLE REPOSITORY FILES:\n{manifest_text}\n\n"
        "Return the minimal set of files that need to be modified."
    )

    payload = {
        "system_instruction": {"parts": [{"text": system_instruction}]},
        "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "temperature": 0.1,
            "thinkingConfig": {"thinkingBudget": 0}
        }
    }

    for model in DEFAULT_MODELS:
        try:
            log(f"Selecting relevant files using {model}...")
            res = call_gemini_api(api_key, payload, model, timeout=30)
            files = res.get("files", [])
            valid_files = [f for f in files if os.path.exists(os.path.join(REPO_ROOT, f))]
            if valid_files:
                # Also check if user explicitly mentions a file
                for k in CORE_MANIFEST.keys():
                    if k in issue_info['prompt'] and k not in valid_files and os.path.exists(os.path.join(REPO_ROOT, k)):
                        valid_files.append(k)
                log(f"Selected files: {valid_files}")
                return valid_files
        except Exception as e:
            log(f"Phase 1 model {model} failed: {e}")

    # Fallback to sensible defaults
    fallback = ["styles.css", "index.html", "app.js"]
    log(f"Using default fallback files: {fallback}")
    return [f for f in fallback if os.path.exists(os.path.join(REPO_ROOT, f))]

def call_gemini_coder(api_key, issue_info, codebase):
    """Phase 2: Generate targeted search-and-replace edits."""
    files_prompt = "\n\n".join([f"--- FILE: {path} ---\n{content}" for path, content in codebase.items()])

    system_instruction = (
        "You are an expert autonomous software engineer working on 'macromix', a mobile-first "
        "PWA macro tracker built with HTML5, Neo-brutalist CSS3 (thick black borders, bold colors, 3D shadows), "
        "and vanilla JavaScript.\n\n"
        "Output STRICTLY a valid JSON object matching this schema:\n"
        "{\n"
        "  \"summary\": \"Concise summary of changes made\",\n"
        "  \"edits\": [\n"
        "    {\n"
        "      \"path\": \"filename (e.g. styles.css, app.js)\",\n"
        "      \"search\": \"EXACT verbatim snippet of code from the file to replace (3-10 lines of context)\",\n"
        "      \"replace\": \"new replacement code\"\n"
        "    }\n"
        "  ],\n"
        "  \"new_files\": [\n"
        "    {\n"
        "      \"path\": \"path/to/new_file\",\n"
        "      \"content\": \"full content only if creating a brand new file\"\n"
        "    }\n"
        "  ]\n"
        "}\n\n"
        "CRITICAL RULES:\n"
        "1. For existing files, ALWAYS use 'edits' with targeted search and replace blocks. DO NOT output the whole file!\n"
        "2. The 'search' block must be unique and match the existing file verbatim.\n"
        "3. Preserve Neo-brutalist design, security, and all existing features.\n"
    )

    user_prompt = (
        f"TASK: Issue #{issue_info['number']} - {issue_info['title']}\n"
        f"PROMPT FROM USER:\n{issue_info['prompt']}\n\n"
        f"CURRENT CODEBASE:\n{files_prompt}\n\n"
        "Please provide the targeted edits in the required JSON format."
    )

    payload = {
        "system_instruction": {"parts": [{"text": system_instruction}]},
        "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
        "generationConfig": {
            "temperature": 0.1,
            "responseMimeType": "application/json",
            "thinkingConfig": {"thinkingBudget": 0}
        }
    }

    configured_model = os.environ.get("GEMINI_MODEL", DEFAULT_MODELS[0])
    models_to_try = [configured_model] + [m for m in DEFAULT_MODELS if m != configured_model]

    last_err = None
    for model in models_to_try:
        for attempt in range(2):
            try:
                log(f"Calling {model} for code edits (attempt {attempt + 1})...")
                return call_gemini_api(api_key, payload, model, timeout=120)
            except Exception as e:
                log(f"Model {model} attempt {attempt + 1} failed: {e}")
                last_err = e
                time.sleep(2)

    raise last_err or RuntimeError("All Gemini models timed out or failed.")

def apply_search_replace(content, search, replace):
    """Robust search-and-replace handling exact, CRLF, and whitespace variations."""
    if not search:
        return content, False

    # 1. Exact match
    if search in content:
        return content.replace(search, replace, 1), True

    # 2. Normalize CRLF line endings
    c_norm = content.replace("\r\n", "\n")
    s_norm = search.replace("\r\n", "\n")
    r_norm = replace.replace("\r\n", "\n")
    if s_norm in c_norm:
        return c_norm.replace(s_norm, r_norm, 1), True

    # 3. Strip trailing whitespace per line
    def strip_lines(text):
        return "\n".join([line.rstrip() for line in text.split("\n")])

    c_stripped = strip_lines(c_norm)
    s_stripped = strip_lines(s_norm)
    if s_stripped in c_stripped:
        idx = c_stripped.find(s_stripped)
        lines_before = c_stripped[:idx].count("\n")
        search_lines_count = s_stripped.count("\n") + 1
        orig_lines = c_norm.split("\n")
        new_lines = orig_lines[:lines_before] + r_norm.split("\n") + orig_lines[lines_before + search_lines_count:]
        return "\n".join(new_lines), True

    return content, False

def post_github_comment(issue_num, comment_body):
    token = os.environ.get("GITHUB_TOKEN")
    repo = os.environ.get("GITHUB_REPOSITORY")
    if not token or not repo or not issue_num:
        log("Skipping GitHub comment (missing token/repo/issue_num).")
        return

    url = f"https://api.github.com/repos/{repo}/issues/{issue_num}/comments"
    payload = {"body": comment_body}
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json"
        },
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as resp:
            log("Posted comment to issue.")
    except Exception as e:
        log(f"Failed to post comment to issue #{issue_num}: {e}")

def main():
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        # Check local env.js fallback for development
        if os.path.exists("env.js"):
            with open("env.js", "r", encoding="utf-8") as f:
                m = re.search(r'GEMINI_API_KEY\s*:\s*["\']([^"\']+)["\']', f.read())
                if m:
                    api_key = m.group(1)

    if not api_key:
        log("Error: GEMINI_API_KEY environment variable is missing.")
        sys.exit(1)

    issue = get_issue_info()
    log(f"Processing Issue #{issue['number']}: {issue['title']} (by @{issue['author']})")

    # Phase 1: Determine relevant files
    relevant_files = select_relevant_files(api_key, issue)
    codebase = {}
    for path in relevant_files:
        full_path = os.path.join(REPO_ROOT, path)
        try:
            with open(full_path, "r", encoding="utf-8") as f:
                codebase[path] = f.read()
        except Exception as e:
            log(f"Could not read {full_path}: {e}")

    # Phase 2: Call Gemini for code updates
    try:
        ai_response = call_gemini_coder(api_key, issue, codebase)
    except Exception as e:
        err_msg = (
            f"❌ **Gemini AI Coder encountered an error:**\n```\n{e}\n```\n"
            f"Please check your prompt or retry by commenting `/gemini retry`."
        )
        post_github_comment(issue["number"], err_msg)
        log(f"Gemini API call failed: {e}")
        sys.exit(1)

    summary = ai_response.get("summary", "Applied requested changes.")
    edits = ai_response.get("edits", [])
    new_files = ai_response.get("new_files", [])
    modified_files_compat = ai_response.get("modified_files", [])

    modified_paths = set()
    failed_edits = []

    # 1. Apply targeted edits
    for edit in edits:
        path = edit.get("path")
        search = edit.get("search")
        replace = edit.get("replace")
        if not path or not search:
            continue

        clean_path = os.path.normpath(path)
        if clean_path.startswith("..") or os.path.isabs(clean_path):
            continue

        full_path = os.path.join(REPO_ROOT, clean_path)
        if not os.path.exists(full_path):
            continue

        with open(full_path, "r", encoding="utf-8") as f:
            content = f.read()

        new_content, ok = apply_search_replace(content, search, replace)
        if ok:
            with open(full_path, "w", encoding="utf-8") as f:
                f.write(new_content)
            modified_paths.add(clean_path)
            log(f"Successfully applied edit in {clean_path}")
        else:
            log(f"Could not locate search block in {clean_path}")
            failed_edits.append(clean_path)

    # 2. Write new files
    for item in new_files:
        path = item.get("path")
        content = item.get("content")
        if not path or content is None:
            continue
        clean_path = os.path.normpath(path)
        if clean_path.startswith("..") or os.path.isabs(clean_path):
            continue
        full_path = os.path.join(REPO_ROOT, clean_path)
        with open(full_path, "w", encoding="utf-8") as f:
            f.write(content)
        modified_paths.add(clean_path)
        log(f"Created new file {clean_path}")

    # 3. Backward compatibility for full modified_files
    for item in modified_files_compat:
        path = item.get("path")
        content = item.get("content")
        search = item.get("search")
        replace = item.get("replace")
        if not path:
            continue
        clean_path = os.path.normpath(path)
        if clean_path.startswith("..") or os.path.isabs(clean_path):
            continue
        full_path = os.path.join(REPO_ROOT, clean_path)

        if search and replace and os.path.exists(full_path):
            with open(full_path, "r", encoding="utf-8") as f:
                orig = f.read()
            updated, ok = apply_search_replace(orig, search, replace)
            if ok:
                with open(full_path, "w", encoding="utf-8") as f:
                    f.write(updated)
                modified_paths.add(clean_path)
        elif content is not None:
            with open(full_path, "w", encoding="utf-8") as f:
                f.write(content)
            modified_paths.add(clean_path)

    if not modified_paths:
        if failed_edits:
            msg = f"⚠️ **Gemini AI Coder Notice:**\n{summary}\n\nCould not apply edits cleanly to: {', '.join(failed_edits)}. Please retry with more specific context."
        else:
            msg = f"ℹ️ **Gemini AI Coder Review:**\n{summary}\n\nNo code changes were needed."
        post_github_comment(issue["number"], msg)
        log("No files modified.")
        return

    # Syntax validate all modified JS files
    for path in modified_paths:
        if path.endswith(".js"):
            full_path = os.path.join(REPO_ROOT, path)
            try:
                proc = subprocess.run(["node", "-c", full_path], capture_output=True)
                if proc.returncode != 0:
                    err = proc.stderr.decode()
                    log(f"Syntax check failed for {path}:\n{err}")
                    post_github_comment(issue["number"], f"⚠️ **Syntax Validation Error in `{path}`:**\n```\n{err}\n```\nSkipping commit to protect production stability.")
                    sys.exit(1)
            except FileNotFoundError:
                pass

    # Post success comment
    files_list_md = "\n".join([f"- `{p}`" for p in sorted(modified_paths)])
    comment = (
        f"🤖 **Gemini AI Coder Applied Changes**\n\n"
        f"**Summary:** {summary}\n\n"
        f"**Modified Files:**\n{files_list_md}\n\n"
        f"🚀 A commit has been generated. The live app will automatically deploy to "
        f"[macromix.web.app](https://macromix.web.app) in ~30 seconds!"
    )
    post_github_comment(issue["number"], comment)

    with open(os.path.join(REPO_ROOT, "gemini_summary.txt"), "w", encoding="utf-8") as f:
        f.write(f"feat/fix: {issue['title']} (prompted via #{issue['number']})\n\n{summary}")

    log("Successfully finished code updates.")

if __name__ == "__main__":
    main()
