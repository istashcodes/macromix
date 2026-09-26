# Technical Implementation — Real WebAuthn Passkey Auth
### macromix · Android + MacBook + Windows via Google Password Manager

---

## 1. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                        Browser (PWA)                             │
│                                                                  │
│  app.js                      firebase-db.js                      │
│  ├─ passkeyRegister()        ├─ Firebase Auth (signInWith...)    │
│  ├─ passkeyLogin()           └─ Firestore (meals, profile)       │
│  └─ restoreSession()                                             │
│       uses @simplewebauthn/browser (CDN ESM)                     │
└────────────────┬─────────────────────────────────────────────────┘
                 │  HTTPS fetch
┌────────────────▼─────────────────────────────────────────────────┐
│              Firebase Cloud Functions (Node.js 20)               │
│                                                                  │
│  POST /auth/register/begin      POST /auth/login/begin           │
│  POST /auth/register/complete   POST /auth/login/complete        │
│                                                                  │
│  @simplewebauthn/server  →  cryptographic verify                 │
│  firebase-admin          →  Custom Token mint                    │
└────────────────┬─────────────────────────────────────────────────┘
                 │
┌────────────────▼─────────────────────────────────────────────────┐
│                       Cloud Firestore                            │
│                                                                  │
│  users/{uid}                    handleIndex/{handle} → uid       │
│    credentials[]                challenges/{handle}  (temp)      │
│    meals/{mealId}                                                │
│    following/{handle}                                            │
└──────────────────────────────────────────────────────────────────┘
```

### Identity Model Change

| | Before | After |
|---|---|---|
| Identity key | `@handle` string | Firebase Auth `uid` |
| Firestore path | `users/{handle}` | `users/{uid}` |
| Session storage | `localStorage('macromix_user_handle')` | Firebase Auth `onAuthStateChanged` + `localStorage` for display |
| Handle role | Primary key | Display name (unique, indexed in `handleIndex`) |

---

## 2. Prerequisites

```bash
# Upgrade Firebase project to Blaze (pay-as-you-go) plan — required for Cloud Functions
# https://console.firebase.google.com/project/macro-streak-tracker/usage/details

# Install Firebase CLI
npm install -g firebase-tools

# Enable Firebase Auth in console
# Console → Build → Authentication → Get Started → Sign-in method
# Enable: "Custom" (for Custom Tokens)
# Optional: Enable "Email/Password" for future recovery
```

---

## 3. Project Structure After Changes

```
pwa-macro-tracker/
├── functions/                    ← NEW
│   ├── package.json
│   ├── package-lock.json
│   └── index.js                  ← All 4 auth endpoints
├── app.js                        ← Modified: handlePasskeyAuth, session restore
├── firebase-db.js                ← Modified: uid-based profile, localStorage fix
├── firebase.json                 ← Modified: add "functions" block
├── firestore.rules               ← Replaced: uid-based rules
└── index.html                    ← Minor: add Firebase Auth CDN import
```

---

## 4. Cloud Functions

### 4.1 `firebase.json` — Add Functions Block

```json
{
  "functions": {
    "source": "functions",
    "runtime": "nodejs20"
  },
  "firestore": {
    "rules": "firestore.rules",
    "indexes": "firestore.indexes.json"
  },
  "hosting": {
    "site": "macromix",
    "public": ".",
    "rewrites": [
      { "source": "/auth/**", "function": "auth" },
      { "source": "**",       "destination": "/index.html" }
    ]
  }
}
```

### 4.2 `functions/package.json`

```json
{
  "name": "macromix-functions",
  "version": "1.0.0",
  "engines": { "node": "20" },
  "main": "index.js",
  "dependencies": {
    "@simplewebauthn/server": "^10.0.0",
    "firebase-admin": "^12.0.0",
    "firebase-functions": "^5.0.0"
  }
}
```

### 4.3 `functions/index.js` — Complete Implementation

```javascript
const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

admin.initializeApp();
const db = admin.firestore();

// ─────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────
const RP_NAME    = 'macromix';
const RP_ID      = 'macromix-app.web.app';  // Must match your hosting domain exactly
const ORIGIN     = 'https://macromix-app.web.app';
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// CORS helper — allow requests from the PWA origin
function setCORS(res) {
  res.set('Access-Control-Allow-Origin', ORIGIN);
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

/** Validate handle format */
function isValidHandle(h) {
  return typeof h === 'string' && /^[a-z0-9_]{3,12}$/.test(h);
}

/** Resolve handle → uid (or null) */
async function handleToUid(handle) {
  const snap = await db.collection('handleIndex').doc(handle).get();
  return snap.exists ? snap.data().uid : null;
}

/** Get all credential descriptors for a uid (for allowCredentials list) */
async function getCredentials(uid) {
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) return [];
  return snap.data().credentials || [];
}

/** Store a verified challenge with expiry */
async function storeChallenge(handle, challenge) {
  await db.collection('challenges').doc(handle).set({
    challenge,
    expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + CHALLENGE_TTL_MS),
  });
}

/** Read and immediately delete challenge (one-time use) */
async function consumeChallenge(handle) {
  const ref = db.collection('challenges').doc(handle);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const { challenge, expiresAt } = snap.data();
  await ref.delete();
  if (expiresAt.toMillis() < Date.now()) return null; // expired
  return challenge;
}

/** Mint a Firebase Custom Token for a uid */
async function mintToken(uid) {
  return admin.auth().createCustomToken(uid);
}

// ─────────────────────────────────────────────────────────────────
// POST /auth/register/begin
// Body: { handle: string }
// Returns: PublicKeyCredentialCreationOptionsJSON
// ─────────────────────────────────────────────────────────────────
exports.authRegisterBegin = onRequest(async (req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');

  const { handle } = req.body;
  if (!isValidHandle(handle)) {
    return res.status(400).json({ error: 'Invalid handle format.' });
  }

  // Block if handle is already taken
  const existingUid = await handleToUid(handle);
  if (existingUid) {
    return res.status(409).json({ error: 'Handle already registered. Use login instead.' });
  }

  const options = await generateRegistrationOptions({
    rpName:    RP_NAME,
    rpID:      RP_ID,
    userName:  handle,
    userDisplayName: '@' + handle,
    // No authenticatorAttachment → lets browser show all options including Google Password Manager
    authenticatorSelection: {
      residentKey:      'required',   // Forces discoverable/synced passkey
      userVerification: 'required',   // Always require biometric
    },
    attestationType: 'none',          // No hardware attestation needed
    supportedAlgorithmIDs: [-7, -257], // ES256, RS256
  });

  await storeChallenge(handle, options.challenge);
  return res.json(options);
});

// ─────────────────────────────────────────────────────────────────
// POST /auth/register/complete
// Body: { handle: string, attestation: RegistrationResponseJSON }
// Returns: { customToken: string, uid: string }
// ─────────────────────────────────────────────────────────────────
exports.authRegisterComplete = onRequest(async (req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');

  const { handle, attestation } = req.body;
  if (!isValidHandle(handle) || !attestation) {
    return res.status(400).json({ error: 'Invalid request body.' });
  }

  // Re-check handle not taken (race condition guard)
  const existingUid = await handleToUid(handle);
  if (existingUid) {
    return res.status(409).json({ error: 'Handle already taken.' });
  }

  const expectedChallenge = await consumeChallenge(handle);
  if (!expectedChallenge) {
    return res.status(400).json({ error: 'Challenge expired or not found. Please retry.' });
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response:          attestation,
      expectedChallenge,
      expectedOrigin:    ORIGIN,
      expectedRPID:      RP_ID,
      requireUserVerification: true,
    });
  } catch (e) {
    return res.status(400).json({ error: 'Passkey verification failed: ' + e.message });
  }

  if (!verification.verified) {
    return res.status(401).json({ error: 'Passkey not verified.' });
  }

  const { credentialID, credentialPublicKey, counter } = verification.registrationInfo;

  // Create Firebase Auth user (anonymous base, identified by uid)
  const userRecord = await admin.auth().createUser({ displayName: '@' + handle });
  const uid = userRecord.uid;

  // Detect device name from User-Agent (best-effort)
  const ua = req.headers['user-agent'] || '';
  const deviceName = ua.includes('Android') ? 'Android / Chrome'
    : ua.includes('Macintosh') ? 'Mac / Chrome'
    : ua.includes('Windows')   ? 'Windows / Chrome'
    : 'Unknown device';

  const credentialRecord = {
    credentialID:        Buffer.from(credentialID).toString('base64url'),
    credentialPublicKey: Buffer.from(credentialPublicKey).toString('base64url'),
    counter,
    deviceName,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  // Write user doc + handle index atomically
  const batch = db.batch();
  batch.set(db.collection('users').doc(uid), {
    handle,
    uid,
    streak: 0,
    latestStats: { streak: 0, targetPct: 0 },
    dailyTargets: { calories: 2000, protein: 150, carbs: 200, fat: 65, fiber: 35 },
    credentials: [credentialRecord],
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    lastActive: admin.firestore.FieldValue.serverTimestamp(),
  });
  batch.set(db.collection('handleIndex').doc(handle), { uid });
  await batch.commit();

  const customToken = await mintToken(uid);
  return res.json({ customToken, uid, handle });
});

// ─────────────────────────────────────────────────────────────────
// POST /auth/login/begin
// Body: { handle: string }
// Returns: PublicKeyCredentialRequestOptionsJSON
// ─────────────────────────────────────────────────────────────────
exports.authLoginBegin = onRequest(async (req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');

  const { handle } = req.body;
  if (!isValidHandle(handle)) {
    return res.status(400).json({ error: 'Invalid handle.' });
  }

  const uid = await handleToUid(handle);
  if (!uid) {
    return res.status(404).json({ error: 'Handle not found. Did you mean to register?' });
  }

  const storedCreds = await getCredentials(uid);
  if (storedCreds.length === 0) {
    return res.status(404).json({ error: 'No passkeys registered for this handle.' });
  }

  const allowCredentials = storedCreds.map(c => ({
    id:   c.credentialID,
    type: 'public-key',
  }));

  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    allowCredentials,
    userVerification: 'required',
  });

  await storeChallenge(handle, options.challenge);
  return res.json(options);
});

// ─────────────────────────────────────────────────────────────────
// POST /auth/login/complete
// Body: { handle: string, assertion: AuthenticationResponseJSON }
// Returns: { customToken: string, uid: string }
// ─────────────────────────────────────────────────────────────────
exports.authLoginComplete = onRequest(async (req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');

  const { handle, assertion } = req.body;
  if (!isValidHandle(handle) || !assertion) {
    return res.status(400).json({ error: 'Invalid request body.' });
  }

  const uid = await handleToUid(handle);
  if (!uid) {
    return res.status(404).json({ error: 'Handle not found.' });
  }

  const expectedChallenge = await consumeChallenge(handle);
  if (!expectedChallenge) {
    return res.status(400).json({ error: 'Challenge expired or not found. Please retry.' });
  }

  const storedCreds = await getCredentials(uid);
  const credentialID = assertion.id;
  const storedCred = storedCreds.find(c => c.credentialID === credentialID);

  if (!storedCred) {
    return res.status(401).json({ error: 'Passkey not recognised for this account.' });
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response:          assertion,
      expectedChallenge,
      expectedOrigin:    ORIGIN,
      expectedRPID:      RP_ID,
      requireUserVerification: true,
      credential: {
        id:        storedCred.credentialID,
        publicKey: Buffer.from(storedCred.credentialPublicKey, 'base64url'),
        counter:   storedCred.counter,
      },
    });
  } catch (e) {
    return res.status(401).json({ error: 'Assertion verification failed: ' + e.message });
  }

  if (!verification.verified) {
    return res.status(401).json({ error: 'Passkey authentication failed.' });
  }

  // Update counter (replay attack prevention)
  const newCounter = verification.authenticationInfo.newCounter;
  const updatedCreds = storedCreds.map(c =>
    c.credentialID === credentialID ? { ...c, counter: newCounter } : c
  );

  await db.collection('users').doc(uid).update({
    credentials: updatedCreds,
    lastActive: admin.firestore.FieldValue.serverTimestamp(),
  });

  const customToken = await mintToken(uid);
  return res.json({ customToken, uid, handle });
});
```

---

## 5. Firestore Security Rules

Replace [`firestore.rules`](file:///Users/satish.s/Documents/VC/pwa-macro-tracker/firestore.rules) entirely:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // ── User profiles ─────────────────────────────────────────────
    match /users/{uid} {
      // Public reads for leaderboard, streak flaunting, friend discovery
      allow read: if true;
      // Only the authenticated owner can write their own doc
      allow create, update: if request.auth != null
                            && request.auth.uid == uid;
      allow delete: if false;

      // ── Meals ───────────────────────────────────────────────────
      match /meals/{mealId} {
        allow read: if true;  // Public: friends can view meals
        allow write, delete: if request.auth != null
                             && request.auth.uid == uid;
      }

      // ── Following list ──────────────────────────────────────────
      match /following/{targetHandle} {
        allow read: if true;
        allow write, delete: if request.auth != null
                             && request.auth.uid == uid;
      }
    }

    // ── Handle index (public read for uniqueness checks) ──────────
    match /handleIndex/{handle} {
      allow read: if true;
      allow write: if false; // Server-only via Admin SDK
    }

    // ── Challenges (server-only) ───────────────────────────────────
    match /challenges/{handle} {
      allow read, write: if false; // Admin SDK bypasses these rules
    }
  }
}
```

---

## 6. Frontend Changes

### 6.1 `index.html` — Add Firebase Auth + @simplewebauthn/browser

```html
<!-- After existing Firebase Firestore import, add Auth -->
<script type="module">
  import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js';
  import { getAuth, signInWithCustomToken, onAuthStateChanged }
    from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js';

  const firebaseConfig = { /* same config */ };
  const app  = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  window.__macromixAuth = auth;

  onAuthStateChanged(auth, (user) => {
    window.__macromixFirebaseUser = user || null;
  });
</script>
```

### 6.2 Add a Pre-Prompt UX Tip (index.html)

Inside the onboarding form card, before the passkey button:

```html
<!-- Device tip shown only on Mac/Windows Chrome -->
<div id="passkey-device-tip" class="passkey-device-tip hidden">
  💡 When Chrome asks where to save your passkey,
  choose <strong>Google Password Manager</strong> to access it on all your devices.
</div>

<button type="button" id="btn-onboard-passkey" 
        class="btn-onboard-passkey" onclick="handlePasskeyAuth()">
  <span class="btn-passkey-icon">🛡️</span>
  <span>Continue with Passkey</span>
</button>
```

Show/hide the tip in `app.js`:

```javascript
function showDeviceTip() {
  const ua = navigator.userAgent;
  // Show tip on Mac and Windows (not Android, where GPM is the default)
  if (/Macintosh|Windows/.test(ua)) {
    const tip = document.getElementById('passkey-device-tip');
    if (tip) tip.classList.remove('hidden');
  }
}
```

### 6.3 `app.js` — Replace `handlePasskeyAuth()`

```javascript
// ─── Cloud Function base URL ───────────────────────────────────
const AUTH_BASE = 'https://us-central1-macro-streak-tracker.cloudfunctions.net';

// ─── @simplewebauthn/browser (loaded once on demand) ──────────
let _swab = null;
async function getSimpleWebAuthn() {
  if (!_swab) {
    _swab = await import(
      'https://cdn.jsdelivr.net/npm/@simplewebauthn/browser@10/esm/index.js'
    );
  }
  return _swab;
}

// ─── Input helper ─────────────────────────────────────────────
function getHandleInput() {
  const input = document.getElementById('onboarding-handle-input');
  const val   = input ? input.value : '';
  if (!val.trim()) {
    showOnboardingError('Please enter your desired handle first.');
    return null;
  }
  return val.trim().toLowerCase().replace(/^@+/, '');
}

// ─── Main entry point ─────────────────────────────────────────
async function handlePasskeyAuth() {
  await waitForFirebaseDB();
  const clean = getHandleInput();
  if (!clean) return;

  showDeviceTip();

  // Determine register vs login
  let isExisting = false;
  try {
    const isAvailable = await window.MacromixFirebase.checkHandleAvailable(clean);
    isExisting = !isAvailable;
  } catch (e) {}

  if (isExisting) {
    await passkeyLogin(clean);
  } else {
    await passkeyRegister(clean);
  }
}

// ─── Registration ─────────────────────────────────────────────
async function passkeyRegister(handle) {
  let options;
  try {
    const res = await fetch(`${AUTH_BASE}/authRegisterBegin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle }),
    });
    if (!res.ok) {
      const err = await res.json();
      showOnboardingError(err.error || 'Could not start registration.');
      return;
    }
    options = await res.json();
  } catch (e) {
    showOnboardingError('Network error. Please try again.');
    return;
  }

  let attestation;
  try {
    const { startRegistration } = await getSimpleWebAuthn();
    attestation = await startRegistration({ optionsJSON: options });
  } catch (e) {
    // User cancelled or no passkey support
    AppLogger.log('AUTH', 'Registration cancelled/unsupported: ' + e.message, null, 'INFO');
    showOnboardingError('Passkey setup was cancelled. Please try again.');
    return;
  }

  let customToken, uid;
  try {
    const res = await fetch(`${AUTH_BASE}/authRegisterComplete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle, attestation }),
    });
    if (!res.ok) {
      const err = await res.json();
      showOnboardingError(err.error || 'Passkey registration failed.');
      return;
    }
    ({ customToken, uid } = await res.json());
  } catch (e) {
    showOnboardingError('Server error during registration. Please try again.');
    return;
  }

  // Sign into Firebase Auth with the issued custom token
  try {
    await window.__macromixAuth.signInWithCustomToken(customToken);
  } catch (e) {
    showOnboardingError('Could not complete sign-in. Please try again.');
    return;
  }

  AppLogger.log('AUTH', `Passkey registered for @${handle}`, { handle, uid }, 'SUCCESS');
  await registerHandleOnboarding(handle, 'passkey');
}

// ─── Login ────────────────────────────────────────────────────
async function passkeyLogin(handle) {
  let options;
  try {
    const res = await fetch(`${AUTH_BASE}/authLoginBegin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle }),
    });
    if (!res.ok) {
      const err = await res.json();
      showOnboardingError(err.error || 'Could not start login.');
      return;
    }
    options = await res.json();
  } catch (e) {
    showOnboardingError('Network error. Please try again.');
    return;
  }

  let assertion;
  try {
    const { startAuthentication } = await getSimpleWebAuthn();
    assertion = await startAuthentication({ optionsJSON: options });
  } catch (e) {
    AppLogger.log('AUTH', 'Authentication cancelled/unsupported: ' + e.message, null, 'INFO');
    showOnboardingError('Passkey login was cancelled. Please try again.');
    return;
  }

  let customToken, uid;
  try {
    const res = await fetch(`${AUTH_BASE}/authLoginComplete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle, assertion }),
    });
    if (!res.ok) {
      const err = await res.json();
      showOnboardingError(err.error || 'Passkey login failed.');
      return;
    }
    ({ customToken, uid } = await res.json());
  } catch (e) {
    showOnboardingError('Server error during login. Please try again.');
    return;
  }

  try {
    await window.__macromixAuth.signInWithCustomToken(customToken);
  } catch (e) {
    showOnboardingError('Could not complete sign-in. Please try again.');
    return;
  }

  AppLogger.log('AUTH', `Passkey login for @${handle}`, { handle, uid }, 'SUCCESS');
  await registerHandleOnboarding(handle, 'passkey');
}
```

### 6.4 `app.js` — Update `restoreSession` to use Firebase Auth

Replace the `localStorage.getItem('macromix_user_handle')` check with:

```javascript
async function checkAndShowOnboarding() {
  const onboardingEl = document.getElementById('onboarding-screen');
  const badgeEl      = document.getElementById('tab-pill-me');
  const badgeText    = document.getElementById('header-handle-text');

  // 1. Wait for Firebase Auth state to resolve (max 3s)
  const user = await new Promise((resolve) => {
    const unsub = window.__macromixAuth.onAuthStateChanged((u) => {
      unsub();
      resolve(u);
    });
    setTimeout(() => resolve(null), 3000);
  });

  if (user) {
    // Fetch profile from Firestore using uid
    const profile = await window.MacromixFirebase.getProfileByUid(user.uid);
    if (profile) {
      currentUserHandle = profile.handle;
      localStorage.setItem('macromix_user_handle', profile.handle); // display cache only
      if (badgeText) badgeText.textContent = '@' + profile.handle;
      if (badgeEl)   badgeEl.style.display = '';
      if (onboardingEl) onboardingEl.classList.add('hidden');
      document.body.style.overflow = '';
      setupRealtimeMealsSync();
      setupCurrentUserProfileSync();
      updateHeaderFriendsBtn();
      return;
    }
  }

  // 2. No Firebase Auth session → show onboarding
  if (onboardingEl) {
    onboardingEl.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }
}
```

### 6.5 `firebase-db.js` — Fixes

**Fix 1: localStorage key typo (line 134)**
```javascript
// BEFORE (wrong key — login path):
localStorage.setItem('macronomics_user_handle', clean);

// AFTER:
localStorage.setItem('macromix_user_handle', clean);
```

**Fix 2: Add `getProfileByUid()` for session restore**
```javascript
export async function getProfileByUid(uid) {
  const database = initFirebaseDB();
  if (!database || !uid) return null;
  try {
    const snap = await getDoc(doc(database, 'users', uid));
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    console.warn('[Macromix Firebase] getProfileByUid failed:', err);
    return null;
  }
}
```

**Fix 3: Update `createHandleProfile()` to write to `users/{uid}` not `users/{handle}`**

After `signInWithCustomToken`, Firebase Auth is active. `createHandleProfile` should be updated to read from `users/{uid}`:

```javascript
export async function createHandleProfile(handle, authMethod = 'passkey', dailyTargets = null) {
  // Profile was already created by the Cloud Function during registration.
  // This function now only updates lastActive and restores local state on login.
  const database = initFirebaseDB();
  if (!database) return { success: true, offline: true };

  // The uid is now the doc key; resolve it via handleIndex
  const idxSnap = await getDoc(doc(database, 'handleIndex', handle));
  if (!idxSnap.exists()) return { success: false, error: 'Handle not found.' };
  const uid = idxSnap.data().uid;

  const docRef = doc(database, 'users', uid);
  const snap   = await getDoc(docRef);
  if (!snap.exists()) return { success: false, error: 'Profile not found.' };

  const existingData = snap.data();
  await updateDoc(docRef, {
    lastActive: serverTimestamp(),
    ...(dailyTargets && !existingData.dailyTargets ? { dailyTargets } : {}),
  });

  localStorage.setItem('macromix_user_handle', handle);
  return { success: true, profile: existingData, isLogin: true };
}
```

---

## 7. Firestore Data Model

### `users/{uid}`
```
{
  uid:          "firebase-auth-uid",
  handle:       "satish",
  streak:       14,
  latestStats:  { streak: 14, targetPct: 87 },
  dailyTargets: { calories: 2000, protein: 150, carbs: 200, fat: 65, fiber: 35 },
  credentials: [
    {
      credentialID:        "base64url-encoded-id",
      credentialPublicKey: "base64url-encoded-pubkey",
      counter:             42,
      deviceName:          "Android / Chrome",
      createdAt:           timestamp
    },
    {
      credentialID:        "another-base64url-id",   ← added when logging in from Win PC
      credentialPublicKey: "another-base64url-pubkey",
      counter:             1,
      deviceName:          "Windows / Chrome",
      createdAt:           timestamp
    }
  ],
  createdAt:    timestamp,
  lastActive:   timestamp
}
```

### `handleIndex/{handle}`
```
{
  uid: "firebase-auth-uid"    ← maps @satish → uid for lookups
}
```

### `challenges/{handle}` (temporary, TTL 5 min)
```
{
  challenge:  "base64url-random-32-bytes",
  expiresAt:  timestamp
}
```

---

## 8. Google Password Manager Sync — Device Matrix

| Device / Browser | First-time | Subsequent visits | Notes |
|-----------------|-----------|------------------|-------|
| **Android Chrome** | Register → GPM saves passkey automatically | Type handle → biometric → in | Default; no choice needed |
| **MacBook Chrome** (same Google account) | GPM shows synced passkey from Android | Type handle → fingerprint/Google prompt → in | Must choose GPM over iCloud Keychain |
| **Windows Chrome** (same Google account) | GPM shows synced passkey from Android | Type handle → Windows Hello / Google prompt → in | Must choose GPM over Windows Hello |
| **MacBook Chrome** (registered first, chose GPM) | GPM saves → syncs to Android + Windows | Same as above | |
| **Windows Chrome** (registered first, chose GPM) | GPM saves → syncs to Android + MacBook | Same as above | |
| **Incognito / new Chrome profile** | QR code scan from phone (CTAP2 hybrid, built into Chrome) | Same QR flow or sign into Google account | No new registration needed |
| **New phone** (Google account restored) | Passkeys restore with Google account | Type handle → biometric → in | Automatic |

---

## 9. Deployment Steps

```bash
# 1. Install function dependencies
cd functions && npm install && cd ..

# 2. Deploy functions first (get the function URLs)
firebase deploy --only functions

# 3. Update AUTH_BASE in app.js with actual function URLs
# (shown in deploy output — format: https://us-central1-<project>.cloudfunctions.net)

# 4. Deploy Firestore rules
firebase deploy --only firestore:rules

# 5. Deploy hosting
firebase deploy --only hosting

# 6. Test locally with emulators first (recommended)
firebase emulators:start --only functions,firestore,auth
# Then set AUTH_BASE = 'http://localhost:5001/macro-streak-tracker/us-central1'
```

---

## 10. Security Properties After Implementation

| Threat | Before | After |
|--------|--------|-------|
| Account takeover by typing handle | ✅ Trivial | ❌ Blocked — biometric + server assertion required |
| Credential replay attack | N/A | ❌ Blocked — counter checked on every login |
| Firestore data tampering by anyone | ✅ Trivial | ❌ Blocked — `auth.uid` required by rules |
| Phishing (fake site stealing passkey) | N/A | ❌ Blocked — `rpId`/`origin` verified server-side |
| Challenge replay | N/A | ❌ Blocked — one-time use, 5-min TTL |
| Session persistence across devices | ❌ localStorage string | ✅ Firebase Auth `onAuthStateChanged` |

---

## 11. Future Extensions (Nice-to-Have)

- **"Add this device" flow** — After login via GPM sync, offer to register an additional credential natively on the current device (saves a roundtrip through GPM on that device).
- **Credential management UI** — Show the user their registered devices and allow removal.
- **Email recovery** — `sendSignInLinkToEmail()` as a break-glass option if all credentials are lost.
- **Autofill passkey** — `navigator.credentials.get({ mediation: 'conditional' })` to show passkeys inline in the handle input field (like password autofill).
