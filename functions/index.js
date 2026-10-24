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

const RP_NAME = 'Macromix';
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getAllowedOrigins() {
  return [
    'https://macromix.web.app',
    'https://macro-streak-tracker.firebaseapp.com',
    'http://localhost:5000',
    'http://127.0.0.1:5000',
    'http://localhost:8000',
    'http://127.0.0.1:8000'
  ];
}

function getRpId(req) {
  const host = (req.headers.host || req.hostname || '').split(':')[0].toLowerCase();
  if (host === 'macromix.web.app') return 'macromix.web.app';
  if (host === 'macro-streak-tracker.firebaseapp.com') return 'macro-streak-tracker.firebaseapp.com';
  if (host === 'localhost' || host === '127.0.0.1') return 'localhost';
  return process.env.PASSKEY_RP_ID || (host || 'macromix.web.app');
}

// CORS helper
function setCORS(req, res) {
  const origin = req.headers.origin;
  const allowed = getAllowedOrigins();
  if (origin && (allowed.includes(origin) || origin.includes('localhost') || origin.includes('127.0.0.1'))) {
    res.set('Access-Control-Allow-Origin', origin);
  } else {
    res.set('Access-Control-Allow-Origin', 'https://macromix.web.app');
  }
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

/** Validate handle format: 3-12 characters, lowercase alphanumeric and underscore */
function isValidHandle(h) {
  return typeof h === 'string' && /^[a-z0-9_]{3,12}$/.test(h);
}

/** Get all credential descriptors for a handle */
async function getCredentials(handle) {
  const snap = await db.collection('users').doc(handle).get();
  if (!snap.exists) return [];
  return snap.data().credentials || [];
}

/** Store a verified challenge with expiry and asynchronously prune stale ones */
async function storeChallenge(handle, challenge) {
  await db.collection('challenges').doc(handle).set({
    challenge,
    expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + CHALLENGE_TTL_MS),
  });

  // Prune expired challenges asynchronously (L3)
  db.collection('challenges')
    .where('expiresAt', '<', admin.firestore.Timestamp.now())
    .limit(10)
    .get()
    .then(snap => {
      if (snap.empty) return;
      const batch = db.batch();
      snap.forEach(d => batch.delete(d.ref));
      return batch.commit();
    })
    .catch(() => {});
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

/** Verify Bearer ID token if present */
async function verifyBearerAuth(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const idToken = authHeader.split('Bearer ')[1].trim();
  try {
    return await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// POST /authRegisterBegin
// Body: { handle: string }
// Returns: PublicKeyCredentialCreationOptionsJSON
// ─────────────────────────────────────────────────────────────────
exports.authRegisterBegin = onRequest({ cors: false }, async (req, res) => {
  setCORS(req, res);
  if (req.method === 'OPTIONS') return res.status(204).send('');

  const { handle } = req.body || {};
  if (!isValidHandle(handle)) {
    return res.status(400).json({ error: 'Invalid handle format. Must be 3-12 characters (lowercase letters, numbers, underscores).' });
  }

  const rpID = getRpId(req);
  const userRef = db.collection('users').doc(handle);
  const snap = await userRef.get();

  let excludeCredentials = [];
  if (snap.exists) {
    const data = snap.data();
    const existingCreds = data.credentials || [];

    // If handle already has passkeys registered, check if user is authenticated to add another device (H6)
    if (existingCreds.length > 0) {
      const authUser = await verifyBearerAuth(req);
      if (!authUser || (authUser.uid !== data.uid && authUser.uid !== data.googleUid)) {
        return res.status(409).json({
          error: 'Handle already claimed by a passkey. Please log in first, or sign in to link this device.'
        });
      }
      excludeCredentials = existingCreds.map(c => ({
        id: c.credentialID,
        type: 'public-key',
      }));
    }
  }

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: handle,
    userDisplayName: '@' + handle,
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
    attestationType: 'none',
    excludeCredentials,
    supportedAlgorithmIDs: [-7, -257],
  });

  await storeChallenge(handle, options.challenge);
  return res.json(options);
});

// ─────────────────────────────────────────────────────────────────
// POST /authRegisterComplete
// Body: { handle: string, attestation: RegistrationResponseJSON }
// Returns: { customToken: string, uid: string, handle: string }
// ─────────────────────────────────────────────────────────────────
exports.authRegisterComplete = onRequest({ cors: false }, async (req, res) => {
  setCORS(req, res);
  if (req.method === 'OPTIONS') return res.status(204).send('');

  const { handle, attestation } = req.body || {};
  if (!isValidHandle(handle) || !attestation) {
    return res.status(400).json({ error: 'Invalid request body.' });
  }

  const rpID = getRpId(req);
  const expectedChallenge = await consumeChallenge(handle);
  if (!expectedChallenge) {
    return res.status(400).json({ error: 'Challenge expired or not found. Please retry.' });
  }

  const userRef = db.collection('users').doc(handle);
  let snap = await userRef.get();

  // If already claimed, ensure this registration is an authenticated device addition (H6)
  if (snap.exists) {
    const data = snap.data();
    if (data.credentials && data.credentials.length > 0) {
      const authUser = await verifyBearerAuth(req);
      if (!authUser || (authUser.uid !== data.uid && authUser.uid !== data.googleUid)) {
        return res.status(409).json({ error: 'Handle already claimed.' });
      }
    }
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: attestation,
      expectedChallenge,
      expectedOrigin: getAllowedOrigins(),
      expectedRPID: rpID,
      requireUserVerification: false,
    });
  } catch (e) {
    return res.status(400).json({ error: 'Passkey verification failed: ' + e.message });
  }

  if (!verification.verified || !verification.registrationInfo) {
    return res.status(401).json({ error: 'Passkey not verified.' });
  }

  const { credentialID, credentialPublicKey, counter } = verification.registrationInfo;

  let uid;
  if (snap.exists && snap.data().uid) {
    uid = snap.data().uid;
  } else {
    const userRecord = await admin.auth().createUser({ displayName: '@' + handle });
    uid = userRecord.uid;
  }

  const ua = req.headers['user-agent'] || '';
  const deviceName = ua.includes('Android') ? 'Android Device'
    : ua.includes('iPhone') || ua.includes('iPad') ? 'iOS Device'
    : ua.includes('Macintosh') ? 'Mac'
    : ua.includes('Windows') ? 'Windows PC'
    : 'Authenticated Device';

  const credentialRecord = {
    credentialID: Buffer.from(credentialID).toString('base64url'),
    credentialPublicKey: Buffer.from(credentialPublicKey).toString('base64url'),
    counter,
    deviceName,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (snap.exists) {
    await userRef.update({
      uid,
      credentials: admin.firestore.FieldValue.arrayUnion(credentialRecord),
      lastActive: admin.firestore.FieldValue.serverTimestamp(),
    });
  } else {
    await userRef.set({
      handle,
      uid,
      streak: 0,
      latestStats: { streak: 0, targetPct: 0 },
      dailyTargets: { calories: 2000, protein: 150, carbs: 200, fat: 65, fiber: 35 },
      credentials: [credentialRecord],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      lastActive: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  const customToken = await mintToken(uid);
  return res.json({ customToken, uid, handle });
});

// ─────────────────────────────────────────────────────────────────
// POST /authLoginBegin
// Body: { handle: string }
// Returns: PublicKeyCredentialRequestOptionsJSON
// ─────────────────────────────────────────────────────────────────
exports.authLoginBegin = onRequest({ cors: false }, async (req, res) => {
  setCORS(req, res);
  if (req.method === 'OPTIONS') return res.status(204).send('');

  const { handle } = req.body || {};
  if (!isValidHandle(handle)) {
    return res.status(400).json({ error: 'Invalid handle.' });
  }

  const rpID = getRpId(req);
  const storedCreds = await getCredentials(handle);
  if (storedCreds.length === 0) {
    return res.status(404).json({ error: 'No passkeys registered for this handle. Please register first.' });
  }

  const allowCredentials = storedCreds.map(c => ({
    id: c.credentialID,
    type: 'public-key',
  }));

  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials,
    userVerification: 'preferred',
  });

  await storeChallenge(handle, options.challenge);
  return res.json(options);
});

// ─────────────────────────────────────────────────────────────────
// POST /authLoginComplete
// Body: { handle: string, assertion: AuthenticationResponseJSON }
// Returns: { customToken: string, uid: string, handle: string }
// ─────────────────────────────────────────────────────────────────
exports.authLoginComplete = onRequest({ cors: false }, async (req, res) => {
  setCORS(req, res);
  if (req.method === 'OPTIONS') return res.status(204).send('');

  const { handle, assertion } = req.body || {};
  if (!isValidHandle(handle) || !assertion) {
    return res.status(400).json({ error: 'Invalid request body.' });
  }

  const rpID = getRpId(req);
  const userRef = db.collection('users').doc(handle);
  const snap = await userRef.get();
  if (!snap.exists) {
    return res.status(404).json({ error: 'Handle not found.' });
  }

  const userData = snap.data();
  const storedCreds = userData.credentials || [];
  const uid = userData.uid;

  if (!uid) {
    return res.status(400).json({ error: 'Account not claimed yet.' });
  }

  const expectedChallenge = await consumeChallenge(handle);
  if (!expectedChallenge) {
    return res.status(400).json({ error: 'Challenge expired or not found. Please retry.' });
  }

  const credentialID = assertion.id;
  const storedCred = storedCreds.find(c => c.credentialID === credentialID);
  if (!storedCred) {
    return res.status(401).json({ error: 'Passkey not recognized for this account.' });
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: assertion,
      expectedChallenge,
      expectedOrigin: getAllowedOrigins(),
      expectedRPID: rpID,
      requireUserVerification: false,
      credential: {
        id: storedCred.credentialID,
        publicKey: Buffer.from(storedCred.credentialPublicKey, 'base64url'),
        counter: storedCred.counter,
      },
    });
  } catch (e) {
    return res.status(401).json({ error: 'Assertion verification failed: ' + e.message });
  }

  if (!verification.verified) {
    return res.status(401).json({ error: 'Passkey authentication failed.' });
  }

  const newCounter = verification.authenticationInfo.newCounter;

  // Monotonic counter verification to detect cloned authenticators (M5)
  if (storedCred.counter > 0 && newCounter <= storedCred.counter) {
    console.warn(`[Passkey] Potential clone detected for handle @${handle}: newCounter ${newCounter} <= storedCounter ${storedCred.counter}`);
    return res.status(401).json({ error: 'Security warning: Authenticator counter check failed. Potential clone detected.' });
  }

  const updatedCreds = storedCreds.map(c =>
    c.credentialID === credentialID ? { ...c, counter: newCounter } : c
  );

  await userRef.update({
    credentials: updatedCreds,
    lastActive: admin.firestore.FieldValue.serverTimestamp(),
  });

  const customToken = await mintToken(uid);
  return res.json({ customToken, uid, handle });
});


// ─────────────────────────────────────────────────────────────────
// GET /getLeaderboard (H4)
// Returns: { success: boolean, users: Array<{ handle, streak, latestStats, dailyTargets, lastActive }> }
// ─────────────────────────────────────────────────────────────────
exports.getLeaderboard = onRequest({ cors: false }, async (req, res) => {
  setCORS(req, res);
  if (req.method === 'OPTIONS') return res.status(204).send('');

  try {
    const snap = await db.collection('users')
      .orderBy('streak', 'desc')
      .limit(50)
      .get();

    const leaderboard = [];
    snap.forEach(doc => {
      const data = doc.data();
      // Expose only public leaderboard stats; NEVER expose uid, googleUid, email, deviceId, or credentials!
      leaderboard.push({
        handle: data.handle || doc.id,
        publicUsername: data.publicUsername || data.handle || doc.id,
        streak: typeof data.streak === 'number' ? data.streak : 0,
        latestStats: data.latestStats || { streak: data.streak || 0, targetPct: 0 },
        dailyTargets: data.dailyTargets || data.targets || null,
        lastActive: data.lastActive ? (data.lastActive.toDate ? data.lastActive.toDate().toISOString() : data.lastActive) : null
      });
    });

    return res.json({ success: true, users: leaderboard });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch leaderboard: ' + err.message });
  }
});
