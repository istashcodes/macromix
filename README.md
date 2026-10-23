# 🥣 macromix

> **Voice-first, neo-brutalist macro and calorie tracker powered by Google Gemini AI and Firebase.**  
> Zero tedious barcode scanning. Speak or type your meal naturally, and macromix calculates calories, macros, and portions in seconds.

[![Live App](https://img.shields.io/badge/Live_App-macromix.web.app-FFE600?style=for-the-badge&logo=googlechrome&logoColor=black)](https://macromix.web.app)
[![PWA Ready](https://img.shields.io/badge/PWA-Installable-5C7CFA?style=for-the-badge&logo=pwa&logoColor=white)](https://macromix.web.app)
[![Gemini AI](https://img.shields.io/badge/AI-Gemini_Flash_Latest-4285F4?style=for-the-badge&logo=googlegemini&logoColor=white)](https://aistudio.google.com/)
[![Firebase](https://img.shields.io/badge/Backend-Cloud_Firestore_%26_Functions-FFCA28?style=for-the-badge&logo=firebase&logoColor=black)](https://firebase.google.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-00E5FF?style=for-the-badge)](LICENSE)

---

## ⚡ Highlights

* **🎙️ Natural Voice & Text Logging:** Say *"Had 2 rotis with a bowl of dal, 150g grilled chicken, and an apple"* — Gemini breaks down items, standardized gram weights, calories, protein, carbs, fat, and fiber.
* **🎨 Neo-brutalist Aesthetics:** Bold high-contrast UI, thick borders, brutalist drop-shadows, animated nutrient rings, accessible color contrast, and fluid responsive design across mobile and desktop.
* **🛡️ Passwordless Biometric Passkeys & Google OIDC:** Sign in with Face ID, Touch ID, or Google 1-Tap authentication. Uses server-verified SimpleWebAuthn with counter replay checks and Firebase Custom Tokens.
* **🔥 Daily Streak & Friends System:** Maintain daily consistency streaks (🔥), discover friends by handle, and view their daily macromix circles in real time via a privacy-preserving leaderboard API.
* **📱 Full Offline-Capable PWA:** Install directly to your iOS or Android home screen with instant caching, standalone window frame, background sync, and local-first persistence.

---

## 🏗️ Architecture

```mermaid
flowchart TD
    User([User Voice or Text]) --> PWA[macromix PWA Frontend]
    PWA -->|Proxy Meal Text / Audio| Functions[Firebase Cloud Functions]
    Functions -->|geminiProxy with Server Secret| Gemini[Google Gemini Flash AI (gemini-flash-latest)]
    Gemini -->|Structured JSON Macros| Functions
    Functions -->|Validated Macros| PWA
    PWA -->|Sync Daily Logs & Streaks| Firestore[(Cloud Firestore)]
    PWA -->|Passkey Registration / Login| Functions
    Functions -->|SimpleWebAuthn Validation| Auth[Firebase Custom Token Auth]
    Auth -->|Client Token Sign-In| PWA
    PWA -->|getLeaderboard API| Functions
```

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | Vanilla ES6+ JavaScript, Semantic HTML5, Neo-brutalist CSS3, Service Worker (`sw.js`) |
| **AI Engine** | Google Gemini (`gemini-flash-latest`, with fallback to `gemini-3.8-flash`, `gemini-2.5-flash`, `gemini-2.0-flash`) via server-side proxy |
| **Serverless Backend** | Firebase Cloud Functions (Node.js 20, SimpleWebAuthn, `/geminiProxy`, `/getLeaderboard`) |
| **Local / Python Backend** | FastAPI, SQLite (`backend/database.py`), golden benchmark test suite |
| **Database** | Google Cloud Firestore (Granular security rules, composite indexes) & Realtime DB (locked) |
| **Authentication** | SimpleWebAuthn (Passkeys / FIDO2) + Firebase Auth (Google OIDC & Custom Tokens) |
| **Hosting & CI/CD** | Firebase Hosting CDN & GitHub Actions Automated Deployments |

---

## 🚀 Quick Start (Local Development)

### 1. Clone the repository
```bash
git clone https://github.com/istashcodes/macromix.git
cd macromix
```

### 2. Configure Environment Secrets
All Gemini API calls are securely proxied through Firebase Cloud Functions (`/geminiProxy`), keeping your API key safe on the server side:

* Set the `GEMINI_API_KEY` secret in your Firebase Functions environment or `.env` file inside `functions/`:
  ```bash
  cd functions
  npm install
  # For local emulator testing:
  echo "GEMINI_API_KEY=your_gemini_api_key_here" > .env
  cd ..
  ```

### 3. Run Locally with Firebase Emulators (Recommended)
```bash
# Start Firebase Functions and Hosting emulators
firebase emulators:start
```

Or run any static file server for frontend testing:
```bash
# Using Python 3
python3 -m http.server 8000

# OR using Node.js
npx serve .
```

Open `http://localhost:8000` in your browser.

---

## 🚢 Deployment to Firebase

`macromix` deploys frontend hosting, Cloud Functions, and database security rules together.

### Manual Deploy (Firebase CLI)
```bash
firebase deploy
```
*(Deploys hosting, functions, firestore:rules, firestore:indexes, and database rules).*

### Continuous Deployment via GitHub Actions
Pushing commits to `main` automatically runs [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

Configure these repository secrets under **Settings > Secrets and variables > Actions**:
* `FIREBASE_TOKEN`: CI token generated via `npx firebase-tools login:ci`.
* `GEMINI_API_KEY`: Server-side Gemini API key used by Cloud Functions.

---

## 📁 Repository Structure

```text
macromix/
├── index.html                   # Core PWA markup, accessible dialogs & meta tags
├── styles.css                   # Neo-brutalist design system & accessible contrast styles
├── app.js                       # Frontend controller, event listeners, macro calculations
├── firebase-db.js               # Cloud Firestore, Google Auth & Passkey Custom Token client
├── sw.js                        # Offline asset caching, network timeout fallback, PWA worker
├── manifest.json                # PWA manifest (scope, orientation, standard & maskable icons)
├── simplewebauthn-browser.min.js# Passkey / WebAuthn client library
├── firestore.rules              # Granular Cloud Firestore security rules with validation
├── firestore.indexes.json       # Composite indexes for queries
├── database.rules.json          # Locked down Realtime Database rules
├── firebase.json                # Firebase Hosting rewrites, function definitions, cache headers
├── functions/                   # Firebase Cloud Functions (Node.js 20)
│   ├── index.js                 # WebAuthn auth endpoints, geminiProxy, getLeaderboard
│   └── package.json             # Backend serverless dependencies
├── backend/                     # Python FastAPI & SQLite backend
│   ├── main.py                  # API endpoints with user ID isolation
│   ├── database.py              # SQLite CRUD operations with user ownership checks
│   └── gemini_engine.py         # Backend Gemini integration (gemini-flash-latest)
├── icons/                       # Standard & maskable PWA icons (192x192, 512x512)
├── tests/ & test_*.py           # E2E Playwright & Golden benchmark test suites
└── .github/workflows/
    ├── deploy.yml               # Automated multi-target Firebase deployment
    └── gemini_coder.yml         # Repository maintainer automated coding workflow
```

---

## 🔒 Security & Privacy

* **Server-Side AI Proxy:** Gemini API keys are never exposed in client bundles or `localStorage`. Requests are proxied via `/geminiProxy`.
* **Phishing-Resistant WebAuthn:** Passkeys authenticate against FIDO2 domain rpId standards, with monotonic sign counter validation to block replay attacks.
* **Privacy-Preserving Leaderboard:** The `/getLeaderboard` endpoint strictly aggregates macro totals and public handles, never exposing user emails, UIDs, or private logs.
* **Granular Database Security Rules:** Cloud Firestore enforces strict schema constraints, ownership verification, and handle uniqueness at the database layer.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).