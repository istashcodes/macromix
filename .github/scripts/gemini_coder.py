#!/usr/bin/env python3
"""
gemini_coder.py - Autonomous AI Coder powered by Gemini 3.8 Flash
Reads a GitHub Issue, understands the macromix codebase, generates exact code changes,
and comments back with the results.
"""

import os
import sys
import json
import urllib.request
import urllib.error
import subprocess

CORE_FILES = ["index.html", "styles.css", "app.js", "firebase-db.js"]
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")

def log(msg):
    print(f"[Gemini Coder] {msg}", flush=True)

def get_issue_info():
    event_path = os.environ.get("GITHUB_EVENT_PATH")
    if not event_path or not os.path.exists(event_path):
        log("No GITHUB_EVENT_PATH found. Running in local test mode.")
        return {
            "number": 0,
            "title": "Test Issue",
            "body": "Test body",
            "author": "local_user"
        }
    with open(event_path, "r", encoding="utf-8") as f:
        event = json.load(f)
    issue = event.get("issue", {})
    return {
        "number": issue.get("number", 0),
        "title": issue.get("title", ""),
        "body": issue.get("body", "") or "",
        "author": issue.get("user", {}).get("login", "")
    }

def read_codebase_context():
    context = {}
    for path in CORE_FILES:
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    context[path] = f.read()
            except Exception as e:
                log(f"Warning: could not read {path}: {e}")
    return context

def call_gemini(api_key, issue_info, codebase):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent?key={api_key}"

    files_prompt = "\n\n".join([f"--- FILE: {path} ---\n{content}" for path, content in codebase.items()])

    system_instruction = (
        "You are an expert autonomous software engineer working on 'macromix', a mobile-first "
        "PWA macro tracker built with vanilla HTML5, CSS3 (Neo-brutalism design with thick black borders, "
        "high contrast, bold shadows), and modern JavaScript. "
        "The user opened a GitHub Issue from their phone describing a feature, bug fix, or visual update. "
        "You must analyze the codebase, decide which files need to be modified, and return the complete, "
        "production-ready updated file contents.\n\n"
        "RULES:\n"
        "1. Maintain all existing comments, docstrings, and features unrelated to the request.\n"
        "2. Keep the Neo-brutalist aesthetic intact.\n"
        "3. Preserve client-side security and data structures.\n"
        "4. Output STRICTLY a valid JSON object with no markdown wrapping outside it.\n"
        "JSON SCHEMA:\n"
        "{\n"
        "  \"summary\": \"Concise summary of changes made\",\n"
        "  \"modified_files\": [\n"
        "    {\n"
        "      \"path\": \"filename (e.g. styles.css)\",\n"
        "      \"content\": \"FULL COMPLETE updated code of the file\"\n"
        "    }\n"
        "  ]\n"
        "}"
    )

    user_prompt = (
        f"ISSUE #{issue_info['number']}: {issue_info['title']}\n\n"
        f"DESCRIPTION:\n{issue_info['body']}\n\n"
        f"CURRENT CODEBASE:\n{files_prompt}\n\n"
        "Please provide the updated file contents in the required JSON format."
    )

    payload = {
        "system_instruction": {
            "parts": [{"text": system_instruction}]
        },
        "contents": [{
            "role": "user",
            "parts": [{"text": user_prompt}]
        }],
        "generationConfig": {
            "temperature": 0.2,
            "responseMimeType": "application/json"
        }
    }

    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST"
    )

    with urllib.request.urlopen(req, timeout=120) as resp:
        result = json.loads(resp.read().decode("utf-8"))

    text = result["candidates"][0]["content"]["parts"][0]["text"]
    return json.loads(text)

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
        with urllib.request.urlopen(req, timeout=30) as resp:
            log("Posted comment to issue.")
    except Exception as e:
        log(f"Failed to post comment to issue #{issue_num}: {e}")

def main():
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        log("Error: GEMINI_API_KEY environment variable is missing.")
        sys.exit(1)

    issue = get_issue_info()
    log(f"Processing Issue #{issue['number']}: {issue['title']} (by @{issue['author']})")

    codebase = read_codebase_context()
    log(f"Read {len(codebase)} files from codebase.")

    log(f"Calling {GEMINI_MODEL} to plan and write code...")
    try:
        ai_response = call_gemini(api_key, issue, codebase)
    except Exception as e:
        err_msg = f"❌ **Gemini AI Coder encountered an error:**\n```\n{e}\n```"
        post_github_comment(issue["number"], err_msg)
        log(f"Gemini API call failed: {e}")
        sys.exit(1)

    summary = ai_response.get("summary", "Applied requested changes.")
    modified_files = ai_response.get("modified_files", [])

    if not modified_files:
        msg = f"ℹ️ **Gemini AI Coder Review:**\n{summary}\n\nNo code changes were needed."
        post_github_comment(issue["number"], msg)
        log("No files were modified.")
        return

    applied_paths = []
    for item in modified_files:
        path = item.get("path")
        content = item.get("content")
        if not path or content is None:
            continue

        # Prevent directory traversal
        clean_path = os.path.normpath(path)
        if clean_path.startswith("..") or os.path.isabs(clean_path):
            log(f"Skipping dangerous path: {path}")
            continue

        # Syntax check for JS files before saving
        if clean_path.endswith(".js"):
            try:
                proc = subprocess.run(["node", "-c", "-"], input=content.encode("utf-8"), capture_output=True)
                if proc.returncode != 0:
                    err = proc.stderr.decode()
                    log(f"Syntax check failed for {clean_path}:\n{err}")
                    post_github_comment(issue["number"], f"⚠️ **Syntax Validation Error in {clean_path}:**\n```\n{err}\n```\nSkipping commit to protect production stability.")
                    sys.exit(1)
            except FileNotFoundError:
                pass  # node not available, proceed

        with open(clean_path, "w", encoding="utf-8") as f:
            f.write(content)
        applied_paths.append(clean_path)
        log(f"Updated {clean_path}")

    # Build response comment
    files_list_md = "\n".join([f"- `{p}`" for p in applied_paths])
    comment = (
        f"🤖 **Gemini AI Coder Applied Changes**\n\n"
        f"**Summary:** {summary}\n\n"
        f"**Modified Files:**\n{files_list_md}\n\n"
        f"🚀 A commit has been generated. The live app will automatically redeploy to "
        f"[macromix.web.app](https://macromix.web.app) in ~30 seconds!"
    )
    post_github_comment(issue["number"], comment)

    # Output applied paths for GitHub Actions step
    with open("gemini_summary.txt", "w", encoding="utf-8") as f:
        f.write(f"feat/fix: {issue['title']} (prompted via #{issue['number']})\n\n{summary}")

    log("Successfully finished code updates.")

if __name__ == "__main__":
    main()
