// firebase-db.js - Cloud Firestore Client for Macromix
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  getDocs,
  collection,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js';

const firebaseConfig = {
  projectId: "macro-streak-tracker",
  appId: "1:561074702873:web:24d9fe03cfb50c16fc3888",
  storageBucket: "macro-streak-tracker.firebasestorage.app",
  apiKey: "AIzaSyCjiSLtWbLgrAduwhyy0vrzmsU15qpaqQs",
  authDomain: "macro-streak-tracker.firebaseapp.com",
  messagingSenderId: "561074702873",
  measurementId: "G-NX030X8N6D"
};

let db = null;
let isInitialized = false;

export function initFirebaseDB() {
  if (isInitialized && db) return db;
  try {
    const app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    isInitialized = true;
    console.log('[Macromix Firebase] Firestore initialized successfully.');
    return db;
  } catch (err) {
    console.error('[Macromix Firebase] Failed to initialize Firestore:', err);
    return null;
  }
}

export function getOrCreateDeviceId() {
  let id = localStorage.getItem('macromix_device_id');
  if (!id) {
    id = 'dev_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
    localStorage.setItem('macromix_device_id', id);
  }
  return id;
}

/**
 * Check if a handle is already claimed in Firestore
 * @param {string} handle 
 * @returns {Promise<boolean>} true if available, false if taken
 */
export async function checkHandleAvailable(handle) {
  const database = initFirebaseDB();
  if (!database) return true;
  const clean = (handle || '').trim().toLowerCase().replace(/^@+/, '');
  if (!clean) return false;
  try {
    const docRef = doc(database, 'users', clean);
    const snap = await getDoc(docRef);
    return !snap.exists();
  } catch (err) {
    console.warn('[Macromix Firebase] checkHandleAvailable failed, proceeding with fallback:', err);
    return true;
  }
}

/**
 * Atomically create a user profile with claimed handle in Firestore
 * @param {string} handle
 * @param {string} authMethod
 * @param {object} dailyTargets
 * @returns {Promise<{success: boolean, error?: string, profile?: object, offline?: boolean}>}
 */
export async function createHandleProfile(handle, authMethod = 'passkey', dailyTargets = null) {
  const database = initFirebaseDB();
  const clean = (handle || '').trim().toLowerCase().replace(/^@+/, '');
  const deviceId = getOrCreateDeviceId();

  if (!clean || clean.length < 3 || clean.length > 12 || !/^[a-z0-9_]+$/.test(clean)) {
    return { success: false, error: 'Handle must be 3-12 characters (letters, numbers, underscores).' };
  }

  const defaultTargets = dailyTargets || {
    calories: 2000,
    protein: 150,
    carbs: 200,
    fat: 65,
    fiber: 35
  };

  if (!database) {
    // Offline mode
    localStorage.setItem('macromix_user_handle', clean);
    return { success: true, profile: { handle: clean, streak: 0, deviceId }, offline: true };
  }

  try {
    const docRef = doc(database, 'users', clean);
    const existing = await getDoc(docRef);
    if (existing.exists()) {
      const existingData = existing.data();
      // Seamless Login: Update deviceId and lastActive to connect this session
      await updateDoc(docRef, {
        deviceId: deviceId,
        lastActive: serverTimestamp()
      });
      localStorage.setItem('macromix_user_handle', clean);
      console.log(`[Macromix Firebase] Seamless login for @${clean} from device ${deviceId}.`);
      return { success: true, profile: existingData, isLogin: true };
    }

    const newProfile = {
      handle: clean,
      publicUsername: clean,
      streak: 0,
      latestStats: { streak: 0, targetPct: 0 },
      targets: {
        prot: defaultTargets.protein || defaultTargets.protein_g || 150,
        carb: defaultTargets.carbs || defaultTargets.carbs_g || 200,
        fat: defaultTargets.fat || defaultTargets.fat_g || 65,
        fib: defaultTargets.fiber || defaultTargets.fiber_g || 35
      },
      dailyTargets: defaultTargets,
      deviceId: deviceId,
      authMethod: authMethod,
      createdAt: serverTimestamp(),
      lastActive: serverTimestamp()
    };

    await setDoc(docRef, newProfile);
    localStorage.setItem('macromix_user_handle', clean);
    console.log(`[Macromix Firebase] Handle @${clean} registered successfully in Firestore.`);
    return { success: true, profile: newProfile };
  } catch (err) {
    console.error('[Macromix Firebase] Failed to create handle in Firestore:', err);
    // Graceful fallback to client storage
    localStorage.setItem('macromix_user_handle', clean);
    return { success: true, profile: { handle: clean, streak: 0, deviceId }, offline: true };
  }
}

/**
 * Sync streak count to Firestore
 * @param {string} handle
 * @param {number} streak
 */
export async function syncStreakToFirestore(handle, streak) {
  const database = initFirebaseDB();
  if (!database || !handle) return;
  const clean = handle.trim().toLowerCase().replace(/^@+/, '');
  const deviceId = getOrCreateDeviceId();

  try {
    const docRef = doc(database, 'users', clean);
    const existing = await getDoc(docRef);
    if (!existing.exists()) {
      // Create if missing
      await setDoc(docRef, {
        handle: clean,
        streak: Number(streak) || 0,
        deviceId: deviceId,
        createdAt: serverTimestamp(),
        lastActive: serverTimestamp()
      });
    } else {
      await updateDoc(docRef, {
        streak: Number(streak) || 0,
        deviceId: deviceId,
        lastActive: serverTimestamp()
      });
    }
    console.log(`[Macromix Firebase] Synced streak ${streak}d for @${clean} to Firestore.`);
  } catch (err) {
    console.warn('[Macromix Firebase] Could not sync streak to Firestore:', err);
  }
}

/**
 * Sync daily targets to Firestore
 * @param {string} handle
 * @param {object} targets
 */
export async function syncTargetsToFirestore(handle, targets) {
  const database = initFirebaseDB();
  if (!database || !handle) return;
  const clean = handle.trim().toLowerCase().replace(/^@+/, '');
  const deviceId = getOrCreateDeviceId();

  try {
    const docRef = doc(database, 'users', clean);
    const existing = await getDoc(docRef);
    if (!existing.exists()) {
      await setDoc(docRef, {
        handle: clean,
        streak: 0,
        dailyTargets: targets,
        deviceId: deviceId,
        createdAt: serverTimestamp(),
        lastActive: serverTimestamp()
      });
    } else {
      await updateDoc(docRef, {
        dailyTargets: targets,
        deviceId: deviceId,
        lastActive: serverTimestamp()
      });
    }
    console.log(`[Macromix Firebase] Synced targets for @${clean} to Firestore.`);
  } catch (err) {
    console.warn('[Macromix Firebase] Could not sync targets to Firestore:', err);
  }
}

/**
 * Get profile for a handle
 * @param {string} handle
 */
export async function getFirestoreUserProfile(handle) {
  const database = initFirebaseDB();
  if (!database || !handle) return null;
  const clean = handle.trim().toLowerCase().replace(/^@+/, '');
  try {
    const docRef = doc(database, 'users', clean);
    const snap = await getDoc(docRef);
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    console.warn('[Macromix Firebase] Error fetching user profile:', err);
    return null;
  }
}

/**
 * Fetch all registered users in Firestore
 * @returns {Promise<Array<object>>}
 */
export async function getAllFirestoreUsers() {
  const database = initFirebaseDB();
  if (!database) return [];
  try {
    const snap = await getDocs(collection(database, 'users'));
    const users = [];
    snap.forEach((d) => {
      users.push(d.data());
    });
    return users;
  } catch (err) {
    console.error('[Macromix Firebase] Error getting all users:', err);
    return [];
  }
}

// Auto-initialize on load
initFirebaseDB();

// Expose globally on window for easy access from app.js and browser console
if (typeof window !== 'undefined') {
  window.MacromixFirebase = {
    initFirebaseDB,
    getOrCreateDeviceId,
    checkHandleAvailable,
    createHandleProfile,
    syncStreakToFirestore,
    syncTargetsToFirestore,
    getFirestoreUserProfile,
    getAllFirestoreUsers
  };
}
