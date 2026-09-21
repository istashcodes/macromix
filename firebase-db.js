// firebase-db.js - Cloud Firestore Client for Macromix
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  collection,
  query,
  orderBy,
  onSnapshot,
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

export function sanitizeForFirestore(obj) {
  if (obj === undefined) return null;
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map(sanitizeForFirestore);
  }
  const clean = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      clean[k] = sanitizeForFirestore(v);
    }
  }
  return clean;
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
      const updates = {
        deviceId: deviceId,
        lastActive: serverTimestamp()
      };
      if (!existingData.dailyTargets && dailyTargets) {
        updates.dailyTargets = dailyTargets;
        existingData.dailyTargets = dailyTargets;
      }
      // Seamless Login: Update deviceId and lastActive to connect this session
      await updateDoc(docRef, updates);
      localStorage.setItem('macronomics_user_handle', clean);
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
    await setDoc(docRef, {
      handle: clean,
      streak: Number(streak) || 0,
      deviceId: deviceId,
      lastActive: serverTimestamp()
    }, { merge: true });
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
  if (!database || !handle || !targets) return;
  const clean = handle.trim().toLowerCase().replace(/^@+/, '');
  const deviceId = getOrCreateDeviceId();

  try {
    const docRef = doc(database, 'users', clean);
    await setDoc(docRef, {
      handle: clean,
      dailyTargets: targets,
      deviceId: deviceId,
      lastActive: serverTimestamp()
    }, { merge: true });
    console.log(`[Macromix Firebase] Synced targets for @${clean} to Firestore:`, targets);
  } catch (err) {
    console.warn('[Macromix Firebase] Could not sync targets to Firestore:', err);
  }
}

/**
 * Real-time listener for user profile (targets & streak)
 * @param {string} handle
 * @param {function} callback
 * @returns {function} unsubscribe function
 */
export function subscribeProfileFromFirestore(handle, callback) {
  const database = initFirebaseDB();
  if (!database || !handle || typeof callback !== 'function') return () => {};
  const clean = handle.trim().toLowerCase().replace(/^@+/, '');

  try {
    const docRef = doc(database, 'users', clean);
    const unsubscribe = onSnapshot(docRef, (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data();
        callback(data);
      }
    }, (err) => {
      console.warn('[Macromix Firebase] Real-time profile subscription warning:', err);
    });
    return unsubscribe;
  } catch (err) {
    console.warn('[Macromix Firebase] Could not subscribe to user profile:', err);
    return () => {};
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

/**
 * Save or update a single meal document in users/{handle}/meals/{mealId}
 * @param {string} handle
 * @param {object} meal
 */
export async function saveMealToFirestore(handle, meal) {
  const database = initFirebaseDB();
  if (!database || !handle || !meal || !meal.id) return;
  const clean = handle.trim().toLowerCase().replace(/^@+/, '');
  const mealId = String(meal.id);

  try {
    const mealRef = doc(database, 'users', clean, 'meals', mealId);
    const mealPayload = sanitizeForFirestore({
      id: meal.id,
      meal_type: meal.meal_type || 'snack',
      logged_date: meal.logged_date || (meal.created_at ? String(meal.created_at).split('T')[0] : new Date().toISOString().split('T')[0]),
      logged_time: meal.logged_time || (meal.created_at && String(meal.created_at).includes('T') ? String(meal.created_at).split('T')[1].substring(0, 5) : ''),
      created_at: meal.created_at || new Date().toISOString(),
      raw_transcript: meal.raw_transcript || '',
      engine_used: meal.engine_used || 'gemini_multimodal_ai',
      total_calories: Number(meal.total_calories || meal.totals?.calories) || 0,
      total_protein_g: Number(meal.total_protein_g || meal.totals?.protein) || 0,
      total_carbs_g: Number(meal.total_carbs_g || meal.totals?.carbs) || 0,
      total_fat_g: Number(meal.total_fat_g || meal.totals?.fat) || 0,
      total_fiber_g: Number(meal.total_fiber_g || meal.totals?.fiber) || 0,
      totals: meal.totals || {
        calories: Number(meal.total_calories) || 0,
        protein: Number(meal.total_protein_g) || 0,
        carbs: Number(meal.total_carbs_g) || 0,
        fat: Number(meal.total_fat_g) || 0,
        fiber: Number(meal.total_fiber_g) || 0
      },
      items: Array.isArray(meal.items) ? meal.items : [],
      updatedAt: serverTimestamp()
    });
    await setDoc(mealRef, mealPayload, { merge: true });
    console.log(`[Macromix Firebase] Saved meal #${mealId} for @${clean} to Firestore.`);
    return true;
  } catch (err) {
    console.warn(`[Macromix Firebase] Could not save meal #${mealId} to Firestore:`, err);
    return false;
  }
}

/**
 * Delete a meal document from users/{handle}/meals/{mealId}
 * @param {string} handle
 * @param {string|number} mealId
 */
export async function deleteMealFromFirestore(handle, mealId) {
  const database = initFirebaseDB();
  if (!database || !handle || !mealId) return;
  const clean = handle.trim().toLowerCase().replace(/^@+/, '');
  try {
    const mealRef = doc(database, 'users', clean, 'meals', String(mealId));
    await deleteDoc(mealRef);
    console.log(`[Macromix Firebase] Deleted meal #${mealId} for @${clean} from Firestore.`);
  } catch (err) {
    console.warn(`[Macromix Firebase] Could not delete meal #${mealId} from Firestore:`, err);
  }
}

/**
 * Fetch all meal documents from users/{handle}/meals
 * @param {string} handle
 * @returns {Promise<Array<object>>}
 */
export async function fetchMealsFromFirestore(handle) {
  const database = initFirebaseDB();
  if (!database || !handle) return [];
  const clean = handle.trim().toLowerCase().replace(/^@+/, '');
  try {
    const mealsColl = collection(database, 'users', clean, 'meals');
    const q = query(mealsColl, orderBy('created_at', 'desc'));
    const snap = await getDocs(q);
    const meals = [];
    snap.forEach(d => {
      meals.push(d.data());
    });
    return meals;
  } catch (err) {
    console.warn(`[Macromix Firebase] Could not fetch meals for @${clean} from Firestore:`, err);
    return [];
  }
}

/**
 * Sync local meals with Firestore:
 * 1. Read existing local meals from localStorage.
 * 2. Upload any local meals to Firestore that aren't there yet (e.g. from mobile).
 * 3. Pull latest meals from Firestore and save them in localStorage.
 * @param {string} handle
 * @returns {Promise<Array<object>>}
 */
export async function syncLocalMealsWithFirestore(handle) {
  const database = initFirebaseDB();
  if (!database || !handle) {
    const stored = localStorage.getItem('macronomics_meals');
    return stored ? JSON.parse(stored) : [];
  }
  const clean = handle.trim().toLowerCase().replace(/^@+/, '');

  try {
    // 1. Fetch remote meals from Firestore
    const remoteMeals = await fetchMealsFromFirestore(clean);
    const remoteMap = new Map();
    remoteMeals.forEach(m => remoteMap.set(String(m.id), m));

    // 2. Read local meals
    const stored = localStorage.getItem('macronomics_meals');
    const localMeals = stored ? JSON.parse(stored) : [];

    // 3. Upload any local meals that don't exist remotely (e.g. from mobile)
    for (const localMeal of localMeals) {
      if (localMeal && localMeal.id && !remoteMap.has(String(localMeal.id))) {
        await saveMealToFirestore(clean, localMeal);
        remoteMap.set(String(localMeal.id), localMeal);
      }
    }

    // 4. Combined list sorted by created_at desc
    const combined = Array.from(remoteMap.values());
    combined.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    // 5. Update localStorage
    localStorage.setItem('macronomics_meals', JSON.stringify(combined));
    console.log(`[Macromix Firebase] Synchronized ${combined.length} meals between local and Firestore for @${clean}.`);
    return combined;
  } catch (err) {
    console.warn('[Macromix Firebase] Meal sync fallback to local storage:', err);
    const stored = localStorage.getItem('macronomics_meals');
    return stored ? JSON.parse(stored) : [];
  }
}

/**
 * Real-time listener for meals: calls callback whenever Firestore meals change
 * @param {string} handle
 * @param {function} callback
 * @returns {function} unsubscribe function
 */
export function subscribeMealsFromFirestore(handle, callback) {
  const database = initFirebaseDB();
  if (!database || !handle || typeof callback !== 'function') return () => {};
  const clean = handle.trim().toLowerCase().replace(/^@+/, '');

  try {
    const mealsColl = collection(database, 'users', clean, 'meals');
    const q = query(mealsColl, orderBy('created_at', 'desc'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const meals = [];
      snapshot.forEach(d => meals.push(d.data()));
      localStorage.setItem('macronomics_meals', JSON.stringify(meals));
      callback(meals);
    }, (err) => {
      console.warn('[Macromix Firebase] Real-time meals subscription warning:', err);
    });
    return unsubscribe;
  } catch (err) {
    console.warn('[Macromix Firebase] Could not subscribe to meals:', err);
    return () => {};
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
    getAllFirestoreUsers,
    saveMealToFirestore,
    deleteMealFromFirestore,
    fetchMealsFromFirestore,
    syncLocalMealsWithFirestore,
    subscribeMealsFromFirestore,
    subscribeProfileFromFirestore
  };
}
