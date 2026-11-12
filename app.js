/**
 * macronomics - Frontend Controller
 * Circles-based Neobrutalism UI with Dual-Engine Voice Logging
 */

// Application State
let currentEngine = 'gemini'; // 'gemini' primary nutrition engine
function getEffectiveGeminiKey() {
  if (typeof window !== 'undefined' && window.__ENV && window.__ENV.GEMINI_API_KEY) {
    return window.__ENV.GEMINI_API_KEY.trim();
  }
  const localKey = typeof localStorage !== 'undefined' ? localStorage.getItem('macronomics_gemini_key') : null;
  if (localKey && localKey.trim()) {
    return localKey.trim();
  }
  return "";
}

const GLOBAL_GEMINI_API_KEY = getEffectiveGeminiKey();
let userTargets = { calories: 2000, protein_g: 150, carbs_g: 200, fat_g: 65, fiber_g: 30 };
let userGeminiInfo = { free_remaining: 0, has_custom_key: false, can_use_gemini: false, gemini_api_key: "", masked_key: "Not set" };
let currentLogs = [];
let isLoadingMeals = true;
let currentUserHandle = null;
let currentTab = 'me';
let isVisitorMode = false;
let viewedHandle = null;
let currentUserStreak = 0;
let unsubscribeCurrentUserListener = null;
let allFirestoreUsersCache = null;
let allFirestoreUsersCacheTime = 0;
const USERS_CACHE_TTL_MS = 30000;
let followingListCache = new Set();

function isLocalBackend() {
  return window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
}

function getMealsStorageKey(handle) {
  const h = handle || currentUserHandle;
  const clean = h ? h.trim().toLowerCase().replace(/^@+/, '') : '';
  return clean ? `macronomics_meals_${clean}` : 'macronomics_meals';
}

function cleanContaminatedMealsFromLocalStorage() {
  const kataraIds = new Set([
    '1790328742293', '1790328719098', '1790318658237', '1790318617484',
    '1790269604326', '1790269533945', '1790269387538', '1790248978776',
    '1790173967281', '1790173734081', '1790150441677', '1790150385355'
  ]);

  // Clean legacy key
  const legacy = localStorage.getItem('macronomics_meals');
  if (legacy) {
    try {
      const parsed = JSON.parse(legacy);
      if (Array.isArray(parsed)) {
        const cleaned = parsed.filter(m => {
          if (!m || !m.id) return false;
          if (kataraIds.has(String(m.id))) return false;
          if (m.owner_handle && currentUserHandle && m.owner_handle.toLowerCase() !== currentUserHandle.toLowerCase()) return false;
          return true;
        });
        if (currentUserHandle) {
          localStorage.setItem(getMealsStorageKey(currentUserHandle), JSON.stringify(cleaned));
        }
      }
    } catch (e) {}
    localStorage.removeItem('macronomics_meals');
  }

  // Clean namespaced key
  if (currentUserHandle) {
    const key = getMealsStorageKey(currentUserHandle);
    const stored = localStorage.getItem(key);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          const cleaned = parsed.filter(m => {
            if (!m || !m.id) return false;
            if (kataraIds.has(String(m.id))) return false;
            if (m.owner_handle && currentUserHandle && m.owner_handle.toLowerCase() !== currentUserHandle.toLowerCase()) return false;
            return true;
          });
          localStorage.setItem(key, JSON.stringify(cleaned));
        }
      } catch (e) {}
    }
  }
}

// Web Audio API State
let mediaRecorder = null;
let audioChunks = [];
let audioContext = null;
let analyser = null;
let micStream = null;
let visualizerAnimationId = null;
let silenceTimer = null;
let isRecording = false;
let isProcessingLog = false;
let speechRecognition = null;
let liveTranscript = '';

// DOM Elements
const engineUsdaBtn = document.getElementById('engine-usda-btn');
const engineGeminiBtn = document.getElementById('engine-gemini-btn');
const geminiBadge = document.getElementById('gemini-badge');
const micStatusText = document.getElementById('mic-status-text');
const btnTapRecord = document.getElementById('btn-tap-record');
const manualTextInput = document.getElementById('manual-text-input');

// Live Application Debug Logger
const AppLogger = {
  logs: [],
  activeFilter: 'ALL',
  lastBackendLogId: 0,
  pollTimer: null,
  isPolling: false,

  init() {
    this.fetchBackendLogs();
    this.log('UI', 'Macronomics application initialized', { 
      engine: currentEngine,
      userAgent: navigator.userAgent.substring(0, 80)
    });
  },

  log(category, message, details = null, level = 'INFO') {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) + 
      '.' + String(now.getMilliseconds()).padStart(3, '0');
    
    const entry = {
      id: 'ui_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      timestamp: timeStr,
      category: category.toUpperCase(),
      message: message,
      details: details,
      level: level.toUpperCase()
    };
    this.appendEntry(entry);
  },

  appendEntry(entry) {
    this.logs.push(entry);
    if (this.logs.length > 1000) {
      this.logs.shift();
      const feed = document.getElementById('debug-feed');
      if (feed && feed.firstChild) {
        feed.removeChild(feed.firstChild);
      }
    }
    this.renderEntry(entry);
    this.updateStats();
  },

  renderEntry(entry) {
    const feed = document.getElementById('debug-feed');
    if (!feed) return;

    const emptyMsg = document.getElementById('debug-empty-msg');
    if (emptyMsg) emptyMsg.style.display = 'none';

    const card = document.createElement('div');
    const catLower = entry.category.toLowerCase();
    card.className = `debug-card cat-${catLower}`;
    card.dataset.category = entry.category;
    card.dataset.level = entry.level;

    // Filter check
    if (this.activeFilter !== 'ALL') {
      if (this.activeFilter === 'ERROR') {
        if (entry.level !== 'ERROR' && entry.category !== 'ERROR') card.style.display = 'none';
      } else if (entry.category !== this.activeFilter) {
        card.style.display = 'none';
      }
    }

    let detailsHtml = '';
    if (entry.details !== null && entry.details !== undefined) {
      let formattedJson = '';
      try {
        formattedJson = typeof entry.details === 'object'
          ? JSON.stringify(entry.details, null, 2)
          : String(entry.details);
      } catch (e) {
        formattedJson = String(entry.details);
      }
      detailsHtml = `
        <details class="debug-detail-block">
          <summary class="debug-detail-summary">Payload / Process Details</summary>
          <pre class="debug-json">${escapeHtml(formattedJson)}</pre>
        </details>
      `;
    }

    card.innerHTML = `
      <div class="debug-card-header">
        <span class="debug-tag tag-${catLower}">${escapeHtml(entry.category)}</span>
        <span class="debug-time">${escapeHtml(entry.timestamp)}</span>
      </div>
      <div class="debug-card-body">${escapeHtml(entry.message)}</div>
      ${detailsHtml}
    `;

    feed.appendChild(card);

    const autoScrollChk = document.getElementById('debug-autoscroll-chk');
    if (autoScrollChk && autoScrollChk.checked) {
      feed.scrollTop = feed.scrollHeight;
    }
  },

  updateStats() {
    const countBadge = document.getElementById('debug-badge-count');
    if (countBadge) {
      countBadge.textContent = `${this.logs.length} logs`;
    }
    const summaryEl = document.getElementById('debug-footer-summary');
    if (summaryEl) {
      const errCount = this.logs.filter(l => l.level === 'ERROR' || l.category === 'ERROR').length;
      summaryEl.textContent = `Filter: ${this.activeFilter} • Errors: ${errCount}`;
    }
  },

  async fetchBackendLogs() {
    if (!isLocalBackend()) return;
    if (this.isPolling) return;
    this.isPolling = true;
    try {
      const res = await fetch(`/api/debug/logs?since_id=${this.lastBackendLogId}`);
      const ct = res.headers.get('content-type') || '';
      if (res.ok && ct.includes('application/json')) {
        const data = await res.json();
        if (data.logs && data.logs.length > 0) {
          for (const bLog of data.logs) {
            if (bLog.id > this.lastBackendLogId) {
              this.lastBackendLogId = bLog.id;
              this.appendEntry({
                id: 'be_' + bLog.id,
                timestamp: bLog.timestamp,
                category: bLog.category,
                message: bLog.message,
                details: bLog.details,
                level: bLog.level
              });
            }
          }
        }
      }
    } catch (e) {
      // Backend might be restarting momentarily
    } finally {
      this.isPolling = false;
    }
  },

  startPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.fetchBackendLogs();
    this.pollTimer = setInterval(() => this.fetchBackendLogs(), 1200);
  },

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  },

  filter(category) {
    this.activeFilter = category;
    const tabs = document.querySelectorAll('.debug-filter-tab');
    tabs.forEach(t => {
      if (t.dataset.cat === category) t.classList.add('active');
      else t.classList.remove('active');
    });

    const feed = document.getElementById('debug-feed');
    if (!feed) return;
    const cards = feed.querySelectorAll('.debug-card');
    let visibleCount = 0;
    cards.forEach(c => {
      const cat = c.dataset.category;
      const lvl = c.dataset.level;
      let show = false;
      if (category === 'ALL') {
        show = true;
      } else if (category === 'ERROR') {
        show = (lvl === 'ERROR' || cat === 'ERROR');
      } else {
        show = (cat === category);
      }
      c.style.display = show ? '' : 'none';
      if (show) visibleCount++;
    });

    const emptyMsg = document.getElementById('debug-empty-msg');
    if (emptyMsg) {
      if (visibleCount === 0 && this.logs.length > 0) {
        emptyMsg.style.display = 'block';
        emptyMsg.textContent = `No logs matching filter "${category}".`;
      } else if (this.logs.length === 0) {
        emptyMsg.style.display = 'block';
        emptyMsg.textContent = "No logs recorded yet. Perform any action in the app!";
      } else {
        emptyMsg.style.display = 'none';
      }
    }
    this.updateStats();
  },

  async clear() {
    this.logs = [];
    const feed = document.getElementById('debug-feed');
    if (feed) {
      feed.innerHTML = '<div class="debug-empty" id="debug-empty-msg">No logs recorded yet. Perform any action in the app!</div>';
    }
    try {
      await fetch('/api/debug/clear', { method: 'POST' });
    } catch (e) {}
    this.updateStats();
    this.log('UI', 'Debug console logs cleared');
  },

  copy() {
    const text = this.logs.map(l => {
      const detailsStr = l.details ? ' | Details: ' + JSON.stringify(l.details) : '';
      return `[${l.timestamp}] [${l.category}] [${l.level}] ${l.message}${detailsStr}`;
    }).join('\n');

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        alert("Debug logs successfully copied to clipboard!");
      }).catch(() => {
        prompt("Copy logs manually:", text);
      });
    } else {
      prompt("Copy logs manually:", text);
    }
  }
};

// Sidebar Controller Functions
function toggleDebugSidebar() {
  const sidebar = document.getElementById('debug-sidebar');
  const backdrop = document.getElementById('debug-sidebar-backdrop');
  if (!sidebar) return;
  const isHidden = sidebar.classList.contains('hidden');
  if (isHidden) {
    sidebar.classList.remove('hidden');
    sidebar.setAttribute('aria-hidden', 'false');
    if (backdrop) backdrop.classList.remove('hidden');
    AppLogger.log('UI', 'Opened live debug console sidebar');
    AppLogger.startPolling();
  } else {
    sidebar.classList.add('hidden');
    sidebar.setAttribute('aria-hidden', 'true');
    if (backdrop) backdrop.classList.add('hidden');
    AppLogger.log('UI', 'Closed live debug console sidebar');
    AppLogger.stopPolling();
  }
}

function filterDebugLogs(cat) {
  AppLogger.filter(cat);
}

function clearAllDebugLogs() {
  AppLogger.clear();
}

function copyAllDebugLogs() {
  AppLogger.copy();
}

window.toggleDebugSidebar = toggleDebugSidebar;
window.filterDebugLogs = filterDebugLogs;
window.clearAllDebugLogs = clearAllDebugLogs;
window.copyAllDebugLogs = copyAllDebugLogs;
window.AppLogger = AppLogger;
window.changeDate = changeDate;
window.resetToToday = resetToToday;
window.updateLogButtonState = updateLogButtonState;

function setMicStatus(text, isError = false) {
  const el = document.getElementById('mic-status-text');
  if (el) {
    el.textContent = text;
    if (text && text !== 'Mic Idle • Ready to Record') {
      el.classList.add('visible');
      const lower = text.toLowerCase();
      if (isError || lower.includes('error') || lower.includes('failed') || lower.includes('could not') || lower.includes('no food') || lower.includes('required')) {
        el.classList.add('status-error');
      } else {
        el.classList.remove('status-error');
      }
    } else {
      el.classList.remove('visible');
      el.classList.remove('status-error');
    }
  }
}

function updateLogButtonState() {
  const submitBtn = document.getElementById('btn-submit-log');
  if (!submitBtn) return;
  if (isProcessingLog) return; // Keep in-flight logging state intact
  const inputVal = manualTextInput ? manualTextInput.value.trim() : '';
  const canLog = inputVal.length > 0 && !isRecording;
  submitBtn.disabled = !canLog;
  if (canLog) {
    submitBtn.classList.remove('btn-disabled');
    submitBtn.style.pointerEvents = 'auto';
  } else {
    submitBtn.classList.add('btn-disabled');
    submitBtn.style.pointerEvents = 'none';
  }
}

function setupInputListeners() {
  if (manualTextInput) {
    manualTextInput.addEventListener('input', updateLogButtonState);
    manualTextInput.addEventListener('keyup', updateLogButtonState);
    manualTextInput.addEventListener('paste', () => setTimeout(updateLogButtonState, 10));
  }
  updateLogButtonState();
}

// Helper to await Firebase DB module initialization
async function waitForFirebaseDB(timeoutMs = 3000) {
  const start = Date.now();
  while (!window.MacromixFirebase && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 50));
  }
  return window.MacromixFirebase;
}

// Initialize on DOM Ready
window.addEventListener('DOMContentLoaded', async () => {
  AppLogger.init();
  setupInputListeners();
  setupLogButtonCapture();
  setupEventListeners();
  setupSwipeGestures();
  setupSettingsModal();
  setupNotificationSettings();
  initWeekendWrappedEvents();
  updateWeekendWrappedVisibility();

  try {
    await waitForFirebaseDB();
  } catch (e) {
    console.warn('[Init] waitForFirebaseDB note:', e);
  }

  try {
    await checkUserProfileOnboarding();
  } catch (e) {
    console.warn('[Init] checkUserProfileOnboarding error:', e);
  }

  try {
    cleanContaminatedMealsFromLocalStorage();
  } catch (e) {}

  try {
    await checkUrlRoute();
  } catch (e) {}

  try {
    updateDateLabel();
    renderStreak();
  } catch (e) {}

  try {
    initServiceWorker();
  } catch (e) {}

  try {
    await loadTargets();
  } catch (e) {}

  try {
    await loadGeminiStatus();
  } catch (e) {}

  try {
    await loadMealLogs();
  } catch (e) {}

  try {
    triggerEmptyStateCardJiggle();
  } catch (e) {}

  try {
    scheduleDailyReminderCheck();
    await initFriendsView();
    initWeekendWrappedEvents();
    updateWeekendWrappedVisibility();
    updateTopAnnouncementBanner();
  } catch (e) {
    console.warn('[Init] Additional feature init note:', e);
  }
});

window.addEventListener('popstate', async () => {
  await checkUrlRoute();
  await loadTargets();
  await loadMealLogs();
});

function setupLogButtonCapture() {
  const submitBtn = document.getElementById('btn-submit-log');
  if (submitBtn) {
    submitBtn.addEventListener('click', (e) => {
      if (isProcessingLog || submitBtn.disabled) {
        e.preventDefault();
        e.stopImmediatePropagation();
        console.warn("[macronomics] Blocked 2nd click on Log CTA during in-flight processing.");
        return false;
      }
    }, true);
  }
}

// --- PWA Service Worker Registration ---
function initServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
      .then(() => console.log('[PWA] Service Worker active'))
      .catch(err => console.log('[PWA] Service Worker registration note:', err));
  }
}

// --- Engine Mode ---
function setEngineMode(mode) {
  currentEngine = 'gemini';
  if (engineUsdaBtn) engineUsdaBtn.classList.toggle('active', mode === 'usda');
  if (engineGeminiBtn) engineGeminiBtn.classList.toggle('active', mode !== 'usda');
}

async function loadGeminiStatus() {
  if (isLocalBackend()) {
    try {
      const res = await fetch('/api/user/gemini');
      const ct = res.headers.get('content-type') || '';
      if (res.ok && ct.includes('application/json')) {
        userGeminiInfo = await res.json();
      }
    } catch (e) {}
  }

  const effectiveKey = getEffectiveGeminiKey();
  if (effectiveKey) {
    userGeminiInfo.gemini_api_key = effectiveKey;
    userGeminiInfo.has_custom_key = true;
    userGeminiInfo.can_use_gemini = true;
    userGeminiInfo.free_remaining = 9999;
    userGeminiInfo.masked_key = effectiveKey.length > 8
      ? `${effectiveKey.slice(0, 4)}...${effectiveKey.slice(-4)}`
      : '...configured';
    AppLogger.log('UI', 'Gemini AI configured with key', { masked_key: userGeminiInfo.masked_key });
  } else {
    userGeminiInfo.gemini_api_key = "";
    userGeminiInfo.has_custom_key = false;
    userGeminiInfo.can_use_gemini = false;
    userGeminiInfo.free_remaining = 0;
    userGeminiInfo.masked_key = "Not set";
    AppLogger.log('UI', 'No Gemini AI key configured');
  }
  updateGeminiBadge();
}

function updateGeminiBadge() {
  if (geminiBadge) {
    if (userGeminiInfo && userGeminiInfo.can_use_gemini) {
      geminiBadge.textContent = "Gemini: Active ⚡";
      geminiBadge.style.background = "var(--fat-color)";
      geminiBadge.style.color = "#1E293B";
    } else {
      geminiBadge.textContent = "Gemini: Setup Key 🔑";
      geminiBadge.style.background = "#F1F5F9";
      geminiBadge.style.color = "#64748B";
    }
  }
}

function saveGeminiApiKeyFromSettings() {
  const input = document.getElementById('settings-gemini-key-input');
  const status = document.getElementById('settings-gemini-key-status');
  if (!input) return;
  const key = input.value.trim();
  if (!key) {
    localStorage.removeItem('macronomics_gemini_key');
    if (status) {
      status.style.color = '#DC2626';
      status.textContent = 'Cleared Gemini key';
    }
  } else {
    localStorage.setItem('macronomics_gemini_key', key);
    if (status) {
      status.style.color = '#16A34A';
      status.textContent = '✓ Saved Gemini key!';
    }
  }
  loadGeminiStatus();
}

// --- Daily Targets & Circles Rendering ---
function applyTargetsToUI() {
  document.getElementById('tgt-cal').textContent = `/ ${Math.round(userTargets.calories)}`;
  document.getElementById('tgt-prot').textContent = `/ ${Math.round(userTargets.protein_g)}g`;
  const tgtCarbEl = document.getElementById('tgt-carb');
  if (tgtCarbEl) tgtCarbEl.textContent = `/ ${Math.round(userTargets.carbs_g)}g`;
  const tgtFiberEl = document.getElementById('tgt-fiber');
  if (tgtFiberEl) tgtFiberEl.textContent = `${Math.round(userTargets.fiber_g !== undefined ? userTargets.fiber_g : 30)}g`;
  document.getElementById('tgt-fat').textContent = `/ ${Math.round(userTargets.fat_g)}g`;
  
  document.getElementById('tgt-input-cal').value = userTargets.calories;
  document.getElementById('tgt-input-prot').value = userTargets.protein_g;
  document.getElementById('tgt-input-carb').value = userTargets.carbs_g;
  const fibInp = document.getElementById('tgt-input-fiber');
  if (fibInp) fibInp.value = userTargets.fiber_g !== undefined ? userTargets.fiber_g : 30;
  document.getElementById('tgt-input-fat').value = userTargets.fat_g;
}

async function loadTargets() {
  if (isVisitorMode && viewedHandle) {
    if (window.MacromixFirebase && typeof window.MacromixFirebase.getFirestoreUserProfile === 'function') {
      try {
        const profile = await window.MacromixFirebase.getFirestoreUserProfile(viewedHandle);
        const raw = profile?.dailyTargets || profile?.targets;
        if (raw) {
          userTargets = {
            calories: Number(raw.calories) || 2000,
            protein_g: Number(raw.protein_g ?? raw.protein ?? raw.prot) || 150,
            carbs_g: Number(raw.carbs_g ?? raw.carbs ?? raw.carb) || 200,
            fiber_g: Number(raw.fiber_g ?? raw.fiber ?? raw.fib) || 30,
            fat_g: Number(raw.fat_g ?? raw.fat) || 65
          };
          applyTargetsToUI();
          updateCirclesProgress();
        }
        if (typeof profile?.streak === 'number') {
          const streakBadge = document.getElementById('streak-badge');
          if (streakBadge) {
            streakBadge.textContent = `🔥 ${profile.streak}d`;
          }
        }
        return;
      } catch (err) {
        console.warn("[macromix] Could not load visitor targets:", err);
      }
    }
    return;
  }

  if (isLocalBackend()) {
    try {
      const res = await fetch('/api/targets');
      const ct = res.headers.get('content-type') || '';
      if (res.ok && ct.includes('application/json')) {
        userTargets = await res.json();
        localStorage.setItem('macronomics_targets', JSON.stringify(userTargets));
        applyTargetsToUI();
        AppLogger.log('UI', 'Daily nutritional targets loaded from backend', userTargets);
        return;
      }
    } catch (e) {}
  }

  // Production Firestore sync across devices
  if (currentUserHandle && window.MacromixFirebase && typeof window.MacromixFirebase.getFirestoreUserProfile === 'function') {
    try {
      const profile = await window.MacromixFirebase.getFirestoreUserProfile(currentUserHandle);
      console.log(`[loadTargets] Fetched profile for @${currentUserHandle}:`, profile);
      if (profile && profile.weekendReviewViewed) {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(`macromix_wrapped_viewed_${currentUserHandle}`, '1');
          localStorage.setItem(`macromix_wrapped_viewed_${currentUserHandle}_2026_w45_nov`, '1');
        }
        updateWeekendWrappedVisibility();
      }
      const raw = profile?.dailyTargets || profile?.targets;
      if (raw) {
        userTargets = {
          calories: Number(raw.calories) || 2000,
          protein_g: Number(raw.protein_g ?? raw.protein ?? raw.prot) || 150,
          carbs_g: Number(raw.carbs_g ?? raw.carbs ?? raw.carb) || 200,
          fiber_g: Number(raw.fiber_g ?? raw.fiber ?? raw.fib) || 30,
          fat_g: Number(raw.fat_g ?? raw.fat) || 65
        };
        localStorage.setItem('macronomics_targets', JSON.stringify(userTargets));
        applyTargetsToUI();
        updateCirclesProgress();
        AppLogger.log('UI', `Daily nutritional targets loaded from Firestore for @${currentUserHandle}`, userTargets);
        return;
      }
    } catch (err) {
      console.warn("[macromix] Could not load targets from Firestore:", err);
    }
  }

  const stored = localStorage.getItem('macronomics_targets');
  if (stored) {
    try { userTargets = JSON.parse(stored); } catch (e) {}
  }
  applyTargetsToUI();
}

async function saveTargets() {
  const rawC = document.getElementById('tgt-input-cal').value.trim();
  const rawP = document.getElementById('tgt-input-prot').value.trim();
  const rawCb = document.getElementById('tgt-input-carb').value.trim();
  const rawFib = document.getElementById('tgt-input-fiber') ? document.getElementById('tgt-input-fiber').value.trim() : "30";
  const rawF = document.getElementById('tgt-input-fat').value.trim();

  const c = parseFloat(rawC);
  const p = parseFloat(rawP);
  const cb = parseFloat(rawCb);
  const fib = parseFloat(rawFib);
  const f = parseFloat(rawF);

  if (isNaN(c) || c <= 0) {
    alert("Daily Calories target must be a positive number greater than 0.");
    return;
  }
  if (isNaN(p) || p < 0 || isNaN(cb) || cb < 0 || isNaN(fib) || fib < 0 || isNaN(f) || f < 0) {
    alert("Macronutrient targets cannot be negative numbers.");
    return;
  }

  AppLogger.log('UI', 'User saving daily nutritional targets', { calories: c, protein_g: p, carbs_g: cb, fiber_g: fib, fat_g: f });
  localStorage.setItem('macronomics_targets', JSON.stringify({ calories: c, protein_g: p, carbs_g: cb, fiber_g: fib, fat_g: f }));
  userTargets = { calories: c, protein_g: p, carbs_g: cb, fiber_g: fib, fat_g: f };

  if (isLocalBackend()) {
    try {
      const res = await fetch('/api/targets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ calories: c, protein_g: p, carbs_g: cb, fiber_g: fib, fat_g: f })
      });
      if (res.ok) {
        await AppLogger.fetchBackendLogs();
      }
    } catch (e) {}
  }

  applyTargetsToUI();
  updateCirclesProgress();
  closeSettingsModal();

  if (window.MacromixFirebase && currentUserHandle) {
    window.MacromixFirebase.syncTargetsToFirestore(currentUserHandle, userTargets);
  }

  AppLogger.log('UI', 'Daily targets successfully saved');
}

// --- Date Navigation State & Logic ---
function getLocalDateString(d = new Date()) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getTodayDateString() {
  return getLocalDateString(new Date());
}

function getYesterdayDateString() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return getLocalDateString(d);
}

let selectedDate = getTodayDateString();

function formatDateLabel(dateStr) {
  if (dateStr === getTodayDateString()) return 'TODAY';
  if (dateStr === getYesterdayDateString()) return 'YESTERDAY';
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
  }
  return dateStr;
}

function formatRimDate(dateStr) {
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    const dayName = d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
    const dateFormatted = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
    if (dateStr === getTodayDateString()) {
      return `TODAY · ${dayName}, ${dateFormatted}`;
    }
    if (dateStr === getYesterdayDateString()) {
      return `YESTERDAY · ${dayName}, ${dateFormatted}`;
    }
    return `${dayName}, ${dateFormatted}`;
  }
  return dateStr;
}

function changeDate(offsetDays, direction = null) {
  if (offsetDays > 0 && selectedDate >= getTodayDateString()) {
    return; // Next arrow is not clickable when on today
  }
  const parts = selectedDate.split('-');
  const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  d.setDate(d.getDate() + offsetDays);
  
  const targetDateStr = getLocalDateString(d);
  if (offsetDays > 0 && targetDateStr > getTodayDateString()) {
    selectedDate = getTodayDateString();
  } else {
    selectedDate = targetDateStr;
  }

  const dir = direction || (offsetDays < 0 ? 'prev' : 'next');
  updateDateLabel();
  filterAndRenderSelectedDate(dir);
  AppLogger.log('UI', `Date switched to ${selectedDate} (${formatDateLabel(selectedDate)})`);
}

function resetToToday() {
  const wasNotToday = (selectedDate !== getTodayDateString());
  selectedDate = getTodayDateString();
  updateDateLabel();
  filterAndRenderSelectedDate(wasNotToday ? 'next' : null);
  AppLogger.log('UI', 'Date reset to TODAY');
}

function updateDateNavButtons() {
  const nextBtn = document.getElementById('btn-date-next');
  const isToday = (selectedDate >= getTodayDateString());
  if (nextBtn) {
    nextBtn.disabled = isToday;
    if (isToday) {
      nextBtn.classList.add('disabled');
      nextBtn.setAttribute('aria-disabled', 'true');
    } else {
      nextBtn.classList.remove('disabled');
      nextBtn.removeAttribute('aria-disabled');
    }
  }
}

function updateInputBarContext() {
  const isToday = (selectedDate >= getTodayDateString());
  const inputEl = document.getElementById('manual-text-input');
  const recordBtnText = document.getElementById('btn-track-text-main');
  const dateName = formatDateLabel(selectedDate);

  if (inputEl) {
    if (isToday) {
      inputEl.placeholder = 'Or type e.g. 200g veg pulao and some veggies';
    } else {
      inputEl.placeholder = `Add forgotten meal for ${dateName.toLowerCase()}...`;
    }
  }
  if (recordBtnText) {
    if (isToday) {
      recordBtnText.innerHTML = 'Track your macro<span class="btn-brand-mix">mix</span>';
    } else {
      recordBtnText.innerHTML = `+ Log for <span style="text-transform: capitalize;">${dateName.toLowerCase()}</span>`;
    }
  }
}

function updateDateLabel() {
  const labelEl = document.getElementById('date-label');
  if (labelEl) {
    labelEl.textContent = formatRimDate(selectedDate);
  }
  const isToday = (selectedDate >= getTodayDateString());
  const dot = document.getElementById('today-indicator');
  if (dot) {
    dot.style.display = isToday ? 'inline-block' : 'none';
  }
  updateDateNavButtons();
  updateInputBarContext();
}

function getLogDate(log) {
  if (!log) return getTodayDateString();

  // If explicitly tagged with calendar date (YYYY-MM-DD)
  if (log.logged_date && typeof log.logged_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(log.logged_date)) {
    return log.logged_date;
  }

  // If created_at timestamp exists, convert to user device's local calendar day
  if (log.created_at) {
    let dateStr = String(log.created_at).trim();
    const hasTz = /Z$/i.test(dateStr) || /[+-]\d{2}(:?\d{2})?$/.test(dateStr);
    if (!hasTz) {
      // Treat SQLite CURRENT_TIMESTAMP (UTC) as UTC by appending Z
      dateStr = dateStr.replace(' ', 'T') + 'Z';
    }
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) {
      return getLocalDateString(d);
    }
  }

  // If client generated ID is an epoch millisecond timestamp
  if (typeof log.id === 'number' && log.id > 1500000000000 && log.id < 3000000000000) {
    const d = new Date(log.id);
    if (!isNaN(d.getTime())) {
      return getLocalDateString(d);
    }
  }

  return getTodayDateString();
}

function hasMacrosEntered(log) {
  if (!log) return false;
  if (log.items && Array.isArray(log.items) && log.items.length > 0) return true;
  if ((Number(log.total_calories) || 0) > 0) return true;
  if ((Number(log.total_protein_g) || 0) > 0) return true;
  if ((Number(log.total_carbs_g) || 0) > 0) return true;
  if ((Number(log.total_fat_g) || 0) > 0) return true;
  if ((Number(log.total_fiber_g) || 0) > 0) return true;
  return false;
}

function calculateStreakForLogs(logs) {
  const todayStr = getTodayDateString();
  const yesterdayStr = getYesterdayDateString();

  const activeDays = new Set();
  (logs || []).forEach(log => {
    if (hasMacrosEntered(log)) {
      activeDays.add(getLogDate(log));
    }
  });

  let streak = 0;
  if (activeDays.has(todayStr)) {
    streak = 1;
    let check = new Date();
    check.setDate(check.getDate() - 1);
    while (activeDays.has(getLocalDateString(check))) {
      streak++;
      check.setDate(check.getDate() - 1);
    }
  } else if (activeDays.has(yesterdayStr)) {
    streak = 1;
    let check = new Date();
    check.setDate(check.getDate() - 2);
    while (activeDays.has(getLocalDateString(check))) {
      streak++;
      check.setDate(check.getDate() - 1);
    }
  } else {
    streak = 0;
  }

  return streak;
}

function calculateStreak() {
  if (isVisitorMode) {
    return currentUserStreak;
  }
  return calculateStreakForLogs(currentLogs);
}

function renderCurrentUserStreak() {
  const streakBadge = document.getElementById('streak-badge');
  if (!streakBadge) return;
  streakBadge.textContent = `🔥 ${currentUserStreak}d`;
  streakBadge.setAttribute('title', `${currentUserStreak} consecutive day${currentUserStreak === 1 ? '' : 's'} logging macros`);
}

function renderStreak() {
  const streakBadge = document.getElementById('streak-badge');
  if (!streakBadge) return;

  // In visitor mode, header streak MUST ALWAYS remain the logged-in user's streak
  if (isVisitorMode) {
    renderCurrentUserStreak();
    return;
  }

  const streak = calculateStreak();
  currentUserStreak = streak;
  renderCurrentUserStreak();

  if (window.MacromixFirebase && currentUserHandle) {
    window.MacromixFirebase.syncStreakToFirestore(currentUserHandle, streak);
  }
}

function setCardLoadingState(loading) {
  isLoadingMeals = !!loading;
  const mainCard = document.getElementById('main-top-card');
  if (mainCard) {
    if (loading) {
      mainCard.classList.add('is-loading');
    } else {
      mainCard.classList.remove('is-loading');
    }
  }
}

function getTimelineSkeletonHtml() {
  return `
    <div class="timeline-skeleton-wrap" aria-busy="true">
      <div class="timeline-skeleton-card">
        <div class="timeline-skeleton-top">
          <div class="timeline-skeleton-left">
            <span class="timeline-skeleton-badge"></span>
            <span class="timeline-skeleton-line timeline-skeleton-title"></span>
          </div>
          <span class="timeline-skeleton-line timeline-skeleton-cal"></span>
        </div>
        <div class="timeline-skeleton-bottom">
          <span class="timeline-skeleton-line timeline-skeleton-sub"></span>
          <div class="timeline-skeleton-chips">
            <span class="timeline-skeleton-chip"></span>
            <span class="timeline-skeleton-chip"></span>
            <span class="timeline-skeleton-chip"></span>
            <span class="timeline-skeleton-chip"></span>
          </div>
        </div>
      </div>
      <div class="timeline-skeleton-card">
        <div class="timeline-skeleton-top">
          <div class="timeline-skeleton-left">
            <span class="timeline-skeleton-badge"></span>
            <span class="timeline-skeleton-line timeline-skeleton-title short"></span>
          </div>
          <span class="timeline-skeleton-line timeline-skeleton-cal"></span>
        </div>
        <div class="timeline-skeleton-bottom">
          <span class="timeline-skeleton-line timeline-skeleton-sub short"></span>
          <div class="timeline-skeleton-chips">
            <span class="timeline-skeleton-chip"></span>
            <span class="timeline-skeleton-chip"></span>
            <span class="timeline-skeleton-chip"></span>
            <span class="timeline-skeleton-chip"></span>
          </div>
        </div>
      </div>
    </div>
  `;
}

function filterAndRenderSelectedDate(direction = null, animateFromZero = true) {
  setCardLoadingState(false);
  const filtered = currentLogs.filter(log => getLogDate(log) === selectedDate);
  renderTimeline(filtered, direction);
  updateCirclesProgress(filtered, animateFromZero);
  updateUnderCard(getOffsetDateString(selectedDate, -1));
  renderStreak();
  triggerEmptyStateCardJiggle();
}

function updateCirclesProgress(logsToUse = null, animateFromZero = false) {
  const logs = logsToUse !== null ? logsToUse : currentLogs.filter(l => getLogDate(l) === selectedDate);
  let totalCal = 0;
  let totalProt = 0;
  let totalCarb = 0;
  let totalFat = 0;
  let totalFiber = 0;

  logs.forEach(log => {
    if (log.items && Array.isArray(log.items) && log.items.length > 0) {
      log.items.forEach(it => {
        totalCal += Number(it.calories) || 0;
        totalProt += Number(it.protein_g) || 0;
        totalCarb += Number(it.carbs_g) || 0;
        totalFat += Number(it.fat_g) || 0;
        totalFiber += Number(it.fiber_g) || 0;
      });
    } else {
      totalCal += Number(log.total_calories) || 0;
      totalProt += Number(log.total_protein_g) || 0;
      totalCarb += Number(log.total_carbs_g) || 0;
      totalFat += Number(log.total_fat_g) || 0;
      totalFiber += Number(log.total_fiber_g) || 0;
    }
  });

  totalCal = Math.round(totalCal);
  totalProt = Math.round(totalProt);
  totalCarb = Math.round(totalCarb);
  totalFat = Math.round(totalFat);
  totalFiber = Math.round(totalFiber);

  const calEl = document.getElementById('val-cal');
  const protEl = document.getElementById('val-prot');
  const carbEl = document.getElementById('val-carb');
  const fiberEl = document.getElementById('val-fiber');
  const fatEl = document.getElementById('val-fat');

  if (calEl) calEl.textContent = totalCal.toLocaleString();
  if (protEl) protEl.textContent = totalProt;
  if (carbEl) carbEl.textContent = totalCarb;
  if (fiberEl) fiberEl.textContent = totalFiber;
  if (fatEl) fatEl.textContent = totalFat;

  const calTgt = userTargets.calories || 2000;
  const protTgt = userTargets.protein_g || 150;
  const carbTgt = userTargets.carbs_g || 200;
  const fiberTgt = userTargets.fiber_g !== undefined ? userTargets.fiber_g : 30;
  const fatTgt = userTargets.fat_g || 65;

  if (animateFromZero) {
    const maxCircumference = 89.2;
    const calcOffset = (cur, tgt) => {
      const pct = Math.min(100, Math.max(0, (cur / (tgt || 1)) * 100));
      return maxCircumference - (pct / 100) * maxCircumference;
    };
    const targetCalPct = Math.min(100, Math.max(0, (totalCal / (calTgt || 1)) * 100));
    const targetProtOffset = calcOffset(totalProt, protTgt);
    const targetCarbOffset = calcOffset(totalCarb, carbTgt);
    const targetFiberOffset = calcOffset(totalFiber, fiberTgt);
    const targetFatOffset = calcOffset(totalFat, fatTgt);

    const items = [
      { id: 'circle-cal', isCal: true, target: targetCalPct },
      { id: 'circle-prot', isCal: false, target: targetProtOffset },
      { id: 'circle-carb', isCal: false, target: targetCarbOffset },
      { id: 'circle-fiber', isCal: false, target: targetFiberOffset },
      { id: 'circle-fat', isCal: false, target: targetFatOffset }
    ];

    // Immediately snap to 0 with transition disabled
    items.forEach(it => {
      const el = document.getElementById(it.id);
      if (!el) return;
      el.style.transition = 'none';
      if (it.isCal) {
        el.style.width = '0%';
      } else {
        el.style.strokeDashoffset = '89.2';
      }
    });

    // Force layout reflow
    const mainCard = document.getElementById('main-top-card');
    if (mainCard) void mainCard.offsetHeight;

    // Animate smoothly to actual target values
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        items.forEach(it => {
          const el = document.getElementById(it.id);
          if (!el) return;
          if (it.isCal) {
            el.style.transition = 'width 0.6s cubic-bezier(0.16, 1, 0.3, 1)';
            el.style.width = it.target + '%';
          } else {
            el.style.transition = 'stroke-dashoffset 0.65s cubic-bezier(0.16, 1, 0.3, 1)';
            el.style.strokeDashoffset = it.target;
          }
        });
      });
    });
  } else {
    setCircleOffset('circle-cal', totalCal, calTgt);
    setCircleOffset('circle-prot', totalProt, protTgt);
    setCircleOffset('circle-carb', totalCarb, carbTgt);
    setCircleOffset('circle-fiber', totalFiber, fiberTgt);
    setCircleOffset('circle-fat', totalFat, fatTgt);
  }

  // Update Calorie Remaining subtitle text
  const calSub = document.getElementById('cal-status-sub');
  if (calSub) {
    const diff = (userTargets.calories || 2000) - totalCal;
    if (diff > 0) {
      calSub.innerHTML = `<strong>${diff.toLocaleString()} kcal left</strong> to goal`;
    } else if (diff === 0) {
      calSub.innerHTML = `<strong>Goal Achieved ✓</strong>`;
    } else {
      calSub.innerHTML = `<strong>${Math.abs(diff).toLocaleString()} kcal over</strong> goal`;
    }
  }

  // Update meals total badge
  const totalBadge = document.getElementById('meals-total-badge');
  if (totalBadge) {
    const validLogs = logs.filter(log => log.items && log.items.length > 0);
    const count = validLogs.reduce((sum, l) => sum + (l.items ? l.items.length : 1), 0);
    totalBadge.textContent = `${count} item${count === 1 ? '' : 's'} · ${totalCal.toLocaleString()} kcal`;
  }
}

function setCircleOffset(elementId, current, target) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const pct = Math.min(100, Math.max(0, (current / (target || 1)) * 100));

  if (elementId === 'circle-cal' || elementId === 'under-circle-cal' || el.classList.contains('cal-bar-fill')) {
    el.style.width = pct + '%';
    return;
  }

  // SVG rings (radius 14.2 -> circumference 89.22)
  const maxCircumference = 89.2;
  const offset = maxCircumference - (pct / 100) * maxCircumference;
  el.style.strokeDashoffset = offset;
}

function getOffsetDateString(baseDateStr, offsetDays) {
  if (!baseDateStr) return getTodayDateString();
  const parts = baseDateStr.split('-');
  const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  d.setDate(d.getDate() + offsetDays);
  return getLocalDateString(d);
}

function updateUnderCard(targetDate) {
  const underCard = document.getElementById('under-top-card');
  if (!underCard || !targetDate) return;

  const underDateLabel = document.getElementById('under-date-label');
  const underTodayIndicator = document.getElementById('under-today-indicator');

  if (underDateLabel) {
    underDateLabel.textContent = formatRimDate(targetDate);
  }
  if (underTodayIndicator) {
    underTodayIndicator.style.display = (targetDate === getTodayDateString()) ? 'inline-block' : 'none';
  }

  const logs = currentLogs.filter(l => getLogDate(l) === targetDate);
  let totalCal = 0;
  let totalProt = 0;
  let totalCarb = 0;
  let totalFat = 0;
  let totalFiber = 0;

  logs.forEach(log => {
    if (log.items && Array.isArray(log.items) && log.items.length > 0) {
      log.items.forEach(it => {
        totalCal += Number(it.calories) || 0;
        totalProt += Number(it.protein_g) || 0;
        totalCarb += Number(it.carbs_g) || 0;
        totalFat += Number(it.fat_g) || 0;
        totalFiber += Number(it.fiber_g) || 0;
      });
    } else {
      totalCal += Number(log.total_calories) || 0;
      totalProt += Number(log.total_protein_g) || 0;
      totalCarb += Number(log.total_carbs_g) || 0;
      totalFat += Number(log.total_fat_g) || 0;
      totalFiber += Number(log.total_fiber_g) || 0;
    }
  });

  totalCal = Math.round(totalCal);
  totalProt = Math.round(totalProt);
  totalCarb = Math.round(totalCarb);
  totalFat = Math.round(totalFat);
  totalFiber = Math.round(totalFiber);

  const underCal = document.getElementById('under-val-cal');
  const underTgtCal = document.getElementById('under-tgt-cal');
  const underProt = document.getElementById('under-val-prot');
  const underCarb = document.getElementById('under-val-carb');
  const underFiber = document.getElementById('under-val-fiber');
  const underFat = document.getElementById('under-val-fat');

  if (underCal) underCal.textContent = totalCal.toLocaleString();
  if (underTgtCal) underTgtCal.textContent = `/ ${(userTargets.calories || 2000).toLocaleString()}`;
  if (underProt) underProt.textContent = totalProt;
  if (underCarb) underCarb.textContent = totalCarb;
  if (underFiber) underFiber.textContent = totalFiber;
  if (underFat) underFat.textContent = totalFat;

  setCircleOffset('under-circle-cal', totalCal, userTargets.calories);
  setCircleOffset('under-circle-prot', totalProt, userTargets.protein_g);
  setCircleOffset('under-circle-carb', totalCarb, userTargets.carbs_g);
  setCircleOffset('under-circle-fiber', totalFiber, userTargets.fiber_g !== undefined ? userTargets.fiber_g : 30);
  setCircleOffset('under-circle-fat', totalFat, userTargets.fat_g);

  const underCalSub = document.getElementById('under-cal-status-sub');
  if (underCalSub) {
    const diff = (userTargets.calories || 2000) - totalCal;
    if (diff > 0) {
      underCalSub.innerHTML = `<strong>${diff.toLocaleString()} kcal left</strong> to goal`;
    } else if (diff === 0) {
      underCalSub.innerHTML = `<strong>Goal Achieved ✓</strong>`;
    } else {
      underCalSub.innerHTML = `<strong>${Math.abs(diff).toLocaleString()} kcal over</strong> goal`;
    }
  }
}

let unsubscribeMealsListener = null;
let unsubscribeProfileListener = null;
let unsubscribeFollowingListener = null;

function clearRealtimeListeners(includeFollowing = false) {
  if (unsubscribeMealsListener) {
    try { unsubscribeMealsListener(); } catch (e) {}
    unsubscribeMealsListener = null;
  }
  if (unsubscribeProfileListener) {
    try { unsubscribeProfileListener(); } catch (e) {}
    unsubscribeProfileListener = null;
  }
  if (includeFollowing && unsubscribeFollowingListener) {
    try { unsubscribeFollowingListener(); } catch (e) {}
    unsubscribeFollowingListener = null;
  }
}

function setupRealtimeMealsSync() {
  const targetHandle = (isVisitorMode && viewedHandle) ? viewedHandle : currentUserHandle;
  if (!targetHandle || !window.MacromixFirebase || typeof window.MacromixFirebase.subscribeMealsFromFirestore !== 'function') return;
  if (unsubscribeMealsListener) {
    try { unsubscribeMealsListener(); } catch (e) {}
    unsubscribeMealsListener = null;
  }
  unsubscribeMealsListener = window.MacromixFirebase.subscribeMealsFromFirestore(targetHandle, (remoteMeals) => {
    if (Array.isArray(remoteMeals)) {
      currentLogs = remoteMeals;
      filterAndRenderSelectedDate();
      if (!isVisitorMode) {
        renderStreak();
        if (currentUserHandle && currentUserHandle.toLowerCase() === targetHandle.toLowerCase()) {
          localStorage.setItem(getMealsStorageKey(currentUserHandle), JSON.stringify(remoteMeals));
        }
      }
      console.log(`[macromix] Real-time sync: ${remoteMeals.length} meals updated for @${targetHandle}.`);
    }
  });
}


function setupCurrentUserProfileSync() {
  if (!currentUserHandle || !window.MacromixFirebase || typeof window.MacromixFirebase.subscribeProfileFromFirestore !== 'function') return;
  if (unsubscribeCurrentUserListener) {
    try { unsubscribeCurrentUserListener(); } catch (e) {}
    unsubscribeCurrentUserListener = null;
  }
  unsubscribeCurrentUserListener = window.MacromixFirebase.subscribeProfileFromFirestore(currentUserHandle, (remoteProfile) => {
    if (remoteProfile) {
      if (remoteProfile.weekendReviewViewed) {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(`macromix_wrapped_viewed_${currentUserHandle}`, '1');
          localStorage.setItem(`macromix_wrapped_viewed_${currentUserHandle}_2026_w45_nov`, '1');
        }
        updateWeekendWrappedVisibility();
      }
      if (typeof remoteProfile.streak === 'number') {
        currentUserStreak = remoteProfile.streak;
        renderCurrentUserStreak();
      }
      if (!isVisitorMode) {
        const raw = remoteProfile.dailyTargets || remoteProfile.targets;
        if (raw) {
          userTargets = {
            calories: Number(raw.calories) || 2000,
            protein_g: Number(raw.protein_g ?? raw.protein ?? raw.prot) || 150,
            carbs_g: Number(raw.carbs_g ?? raw.carbs ?? raw.carb) || 200,
            fiber_g: Number(raw.fiber_g ?? raw.fiber ?? raw.fib) || 30,
            fat_g: Number(raw.fat_g ?? raw.fat) || 65
          };
          localStorage.setItem('macronomics_targets', JSON.stringify(userTargets));
          applyTargetsToUI();
          updateCirclesProgress();
        }
      }
    }
  });
}

function setupRealtimeProfileSync() {
  const targetHandle = (isVisitorMode && viewedHandle) ? viewedHandle : currentUserHandle;
  if (!targetHandle || !window.MacromixFirebase || typeof window.MacromixFirebase.subscribeProfileFromFirestore !== 'function') return;
  if (unsubscribeProfileListener) {
    try { unsubscribeProfileListener(); } catch (e) {}
    unsubscribeProfileListener = null;
  }
  unsubscribeProfileListener = window.MacromixFirebase.subscribeProfileFromFirestore(targetHandle, (remoteProfile) => {
    if (remoteProfile) {
      const raw = remoteProfile.dailyTargets || remoteProfile.targets;
      if (raw) {
        userTargets = {
          calories: Number(raw.calories) || 2000,
          protein_g: Number(raw.protein_g ?? raw.protein ?? raw.prot) || 150,
          carbs_g: Number(raw.carbs_g ?? raw.carbs ?? raw.carb) || 200,
          fiber_g: Number(raw.fiber_g ?? raw.fiber ?? raw.fib) || 30,
          fat_g: Number(raw.fat_g ?? raw.fat) || 65
        };
        if (!isVisitorMode) {
          localStorage.setItem('macronomics_targets', JSON.stringify(userTargets));
        }
        applyTargetsToUI();
        updateCirclesProgress();
        console.log(`[macromix] Real-time sync: daily targets updated for @${targetHandle}.`, userTargets);
      }
      if (isVisitorMode) {
        // Friend's streak goes to the visitor streak pill in the visitor banner, NOT the app header!
        if (typeof remoteProfile.streak === 'number') {
          const visitorStreakPill = document.getElementById('visitor-streak-pill');
          if (visitorStreakPill) {
            visitorStreakPill.textContent = `🔥 ${remoteProfile.streak}d`;
            visitorStreakPill.classList.remove('hidden');
          }
        }
      } else {
        if (typeof remoteProfile.streak === 'number') {
          currentUserStreak = remoteProfile.streak;
          renderCurrentUserStreak();
        }
      }
    }
  });
}

// --- Meal Logs & Timeline ---
async function loadMealLogs() {
  if (isVisitorMode && viewedHandle) {
    setCardLoadingState(true);
    renderTimeline();
    if (window.MacromixFirebase && typeof window.MacromixFirebase.fetchMealsFromFirestore === 'function') {
      try {
        currentLogs = await window.MacromixFirebase.fetchMealsFromFirestore(viewedHandle);
        filterAndRenderSelectedDate();
        AppLogger.log('UI', `Visitor mode: loaded ${currentLogs.length} meals for @${viewedHandle}`);
        return;
      } catch (err) {
        console.warn('[macromix] Could not load visitor meals:', err);
      }
    }
    currentLogs = [];
    filterAndRenderSelectedDate();
    return;
  }

  cleanContaminatedMealsFromLocalStorage();
  const storageKey = getMealsStorageKey(currentUserHandle);

  if (!currentLogs || currentLogs.length === 0) {
    setCardLoadingState(true);
    renderTimeline();
  }

  // 1. Local FastAPI backend if available (local development / tests)
  if (isLocalBackend()) {
    try {
      const res = await fetch('/api/logs');
      const ct = res.headers.get('content-type') || '';
      if (res.ok && ct.includes('application/json')) {
        currentLogs = await res.json();
        if (!isVisitorMode) {
          localStorage.setItem(storageKey, JSON.stringify(currentLogs));
        }
        if (currentUserHandle && window.MacromixFirebase && typeof window.MacromixFirebase.syncLocalMealsWithFirestore === 'function') {
          try {
            await window.MacromixFirebase.syncLocalMealsWithFirestore(currentUserHandle);
          } catch (sErr) {}
        }
        filterAndRenderSelectedDate();
        AppLogger.log('UI', `Timeline updated: ${currentLogs.length} total meal logs loaded`, { count: currentLogs.length });
        checkAndTriggerInstallBanner(false);
        return;
      }
    } catch (e) {
      // Backend unavailable or static hosting on Firebase
    }
  }

  // 2. If user is logged in, sync with Cloud Firestore across all devices (Firebase Hosting production)
  if (currentUserHandle && window.MacromixFirebase && typeof window.MacromixFirebase.syncLocalMealsWithFirestore === 'function') {
    try {
      const fireMeals = await window.MacromixFirebase.syncLocalMealsWithFirestore(currentUserHandle);
      if (Array.isArray(fireMeals)) {
        currentLogs = fireMeals;
        filterAndRenderSelectedDate();
        AppLogger.log('UI', `Timeline updated from Cloud Firestore: ${currentLogs.length} total meals`, { count: currentLogs.length });
        checkAndTriggerInstallBanner(false);
        return;
      }
    } catch (fErr) {
      console.warn('[macromix] Firestore meal sync notice:', fErr);
    }
  }

  const stored = localStorage.getItem(storageKey);
  if (stored) {
    try {
      currentLogs = JSON.parse(stored);
      let needsSave = false;
      currentLogs.forEach(m => {
        if (m.items && Array.isArray(m.items)) {
          if (m.total_calories === undefined || m.total_calories === null) {
            m.total_calories = Math.round(m.items.reduce((s, it) => s + (Number(it.calories) || 0), 0) * 10) / 10;
            m.total_protein_g = Math.round(m.items.reduce((s, it) => s + (Number(it.protein_g) || 0), 0) * 10) / 10;
            m.total_carbs_g = Math.round(m.items.reduce((s, it) => s + (Number(it.carbs_g) || 0), 0) * 10) / 10;
            m.total_fat_g = Math.round(m.items.reduce((s, it) => s + (Number(it.fat_g) || 0), 0) * 10) / 10;
            m.total_fiber_g = Math.round(m.items.reduce((s, it) => s + (Number(it.fiber_g) || 0), 0) * 10) / 10;
            needsSave = true;
          }
          if (!m.logged_date && !m.created_at) {
            m.logged_date = getLogDate(m);
            needsSave = true;
          }
        }
      });
      if (needsSave && !isVisitorMode) {
        localStorage.setItem(storageKey, JSON.stringify(currentLogs));
      }
    } catch (e) {
      currentLogs = [];
    }
  } else {
    currentLogs = [];
  }
  filterAndRenderSelectedDate();
  AppLogger.log('UI', `Loaded ${currentLogs.length} meal logs from local storage`);
  if (currentLogs && currentLogs.length > 0) {
    checkAndTriggerInstallBanner(false);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatItemQuantity(quantity, unit) {
  let q = Number(quantity);
  let qStr = isNaN(q) ? String(quantity || '') : (Number.isInteger(q) ? String(q) : String(Math.round(q * 10) / 10));
  let u = (unit || '').trim();
  
  if (!u) return qStr;
  const uLower = u.toLowerCase();
  if (uLower === 'g' || uLower === 'gram' || uLower === 'grams') {
    return `${qStr}g`;
  }
  if (uLower === 'ml' || uLower === 'milliliter' || uLower === 'milliliters') {
    return `${qStr}ml`;
  }
  if (uLower === 'oz' || uLower === 'ounce' || uLower === 'ounces') {
    return `${qStr}oz`;
  }
  if (uLower === 'serving' || uLower === 'servings') {
    return qStr === '1' ? '1 serving' : `${qStr} servings`;
  }
  return `${qStr} ${u}`;
}

function formatItemCommentary(prepState) {
  if (!prepState || typeof prepState !== 'string') return '';
  let str = prepState.trim().toLowerCase();
  str = str.replace(/[(),.;:]/g, ' ').trim();
  const words = str.split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';

  const priorityMethods = [
    'boiled', 'cooked', 'raw', 'grilled', 'fried', 'steamed', 'baked', 
    'roasted', 'toasted', 'sauteed', 'sautéed', 'braised', 'poached', 
    'smoked', 'broiled', 'mashed', 'blanched', 'cured', 'fresh'
  ];

  let chosen = '';
  for (const m of priorityMethods) {
    if (words.includes(m)) {
      chosen = m;
      break;
    }
  }

  if (!chosen) {
    const ignoredWords = ['standard', 'with', 'and', 'in', 'of', 'from', 'boneless', 'skinless'];
    const candidates = words.filter(w => !ignoredWords.includes(w));
    chosen = candidates.length > 0 ? candidates[0] : words[0];
  }

  // Enforce max 10 characters for commentary
  return chosen.slice(0, 10);
}

function renderTimeline(logsToUse = null, direction = null) {
  const container = document.getElementById('meal-timeline-content');
  if (!container) return;

  if (isLoadingMeals && logsToUse === null) {
    container.innerHTML = getTimelineSkeletonHtml();
    return;
  }

  const logs = logsToUse !== null ? logsToUse : currentLogs.filter(l => getLogDate(l) === selectedDate);
  const validLogs = logs.filter(log => log.items && log.items.length > 0);

  const buildHtml = () => {
    if (!validLogs || validLogs.length === 0) {
      if (selectedDate === getTodayDateString()) {
        return `<div class="empty-state">${isVisitorMode ? `No meals logged yet today by ${viewedHandle || 'user'}.` : 'No meals logged yet today. Tap the mic or type above!'}</div>`;
      } else {
        return `<div class="empty-state">No meals logged ${formatDateLabel(selectedDate)}.</div>`;
      }
    }

    let html = '';
    validLogs.forEach(log => {
      html += `
        <div class="meal-group" id="log-${log.id}">
          <div class="meal-items-list">
      `;

      log.items.forEach(it => {
        const qtyStr = formatItemQuantity(it.quantity, it.unit);
        const commentary = formatItemCommentary(it.preparation_state);
        const subText = commentary ? `${qtyStr} • ${commentary}` : qtyStr;

        html += `
          <div class="meal-item-row" id="item-${it.id}">
            <div class="meal-item-top-line">
              <div class="meal-item-title-wrap">
                <span class="meal-item-title">${escapeHtml(it.food_name)}</span>
                <span class="macro-chip cal">${Math.round(it.calories)} kcal</span>
              </div>
              ${!isVisitorMode ? `
              <div class="item-actions">
                <button type="button" class="item-action-btn edit-item-btn" data-id="${it.id}" data-food="${escapeHtml(it.food_name)}" data-quantity="${it.quantity}" data-unit="${escapeHtml(it.unit)}" data-weight="${it.standardized_weight_g}" title="Edit Portion">✏️</button>
                <button type="button" class="item-action-btn delete-item-btn" data-id="${it.id}" title="Delete Item">🗑️</button>
              </div>` : ''}
            </div>
            <div class="meal-item-bottom-line">
              <span class="meal-item-sub">${escapeHtml(subText)}</span>
              <div class="meal-item-macros">
                <span class="macro-chip prot">${Math.round(it.protein_g)}p</span>
                <span class="macro-chip carb">${Math.round(it.carbs_g)}c</span>
                <span class="macro-chip fib">${Math.round(it.fiber_g || 0)}fib</span>
                <span class="macro-chip fat">${Math.round(it.fat_g)}fat</span>
              </div>
            </div>
          </div>
        `;
      });

      if (log.raw_transcript && log.raw_transcript.trim()) {
        html += `
          <details class="transcript-details">
            <summary class="transcript-summary">💬 Original Transcript</summary>
            <div class="transcript-content">"${escapeHtml(log.raw_transcript.trim())}"</div>
          </details>
        `;
      }

      html += `
          </div>
        </div>
      `;
    });
    return html;
  };

  if (!direction) {
    container.innerHTML = buildHtml();
    setupTimelineDelegation();
    return;
  }

  // Directional Staggered Content Ripple
  const existingCards = container.querySelectorAll('.meal-group');
  const exitOffset = direction === 'prev' ? '16px' : '-16px';
  const enterOffset = direction === 'prev' ? '-16px' : '16px';

  existingCards.forEach(card => {
    card.style.transform = `translateX(${exitOffset})`;
    card.style.opacity = '0';
  });

  setTimeout(() => {
    container.innerHTML = buildHtml();
    setupTimelineDelegation();

    const newCards = container.querySelectorAll('.meal-group');
    newCards.forEach((card, idx) => {
      card.style.opacity = '0';
      card.style.transform = `translateX(${enterOffset})`;
      card.style.transition = 'transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease';
      card.style.transitionDelay = `${idx * 40}ms`;

      requestAnimationFrame(() => {
        setTimeout(() => {
          card.style.opacity = '1';
          card.style.transform = 'translateX(0)';
        }, 20);
      });
    });
  }, 100);
}

function setupTimelineDelegation() {
  const container = document.getElementById('meal-timeline-content');
  if (!container || container.dataset.delegationSet) return;
  container.dataset.delegationSet = "true";
  container.addEventListener('click', (e) => {
    const editBtn = e.target.closest('.edit-item-btn');
    if (editBtn) {
      const id = parseInt(editBtn.dataset.id, 10);
      const food = editBtn.dataset.food;
      const qty = parseFloat(editBtn.dataset.quantity);
      const unit = editBtn.dataset.unit;
      const weight = parseFloat(editBtn.dataset.weight);
      openEditModal(id, food, qty, unit, weight);
      return;
    }
    const delBtn = e.target.closest('.delete-item-btn');
    if (delBtn) {
      const id = parseInt(delBtn.dataset.id, 10);
      deleteFoodItem(id);
      return;
    }
  });
}

async function deleteFoodItem(itemId) {
  if (isVisitorMode) return;
  if (!confirm("Are you sure you want to delete this food item?")) return;
  AppLogger.log('UI', `User initiated deletion of food item #${itemId}`);
  if (isLocalBackend()) {
    try {
      const res = await fetch(`/api/logs/items/${itemId}`, { method: 'DELETE' });
      if (res.ok) {
        await AppLogger.fetchBackendLogs();
      }
    } catch (e) {}
  }

  const storageKey = getMealsStorageKey(currentUserHandle);
  let stored = localStorage.getItem(storageKey);
  let parentMealId = null;
  let updatedParentMeal = null;
  if (stored) {
    try {
      let meals = JSON.parse(stored);
      meals.forEach(m => {
        if ((m.items || []).some(it => it.id === itemId)) {
          parentMealId = m.id;
          m.items = m.items.filter(it => it.id !== itemId);
          m.total_calories = Math.round((m.items || []).reduce((s, i) => s + (Number(i.calories) || 0), 0) * 10) / 10;
          m.total_protein_g = Math.round((m.items || []).reduce((s, i) => s + (Number(i.protein_g) || 0), 0) * 10) / 10;
          m.total_carbs_g = Math.round((m.items || []).reduce((s, i) => s + (Number(i.carbs_g) || 0), 0) * 10) / 10;
          m.total_fiber_g = Math.round((m.items || []).reduce((s, i) => s + (Number(i.fiber_g) || 0), 0) * 10) / 10;
          m.total_fat_g = Math.round((m.items || []).reduce((s, i) => s + (Number(i.fat_g) || 0), 0) * 10) / 10;
          m.updated_at = new Date().toISOString();
          if (m.items.length > 0) updatedParentMeal = m;
        }
      });
      meals = meals.filter(m => m.items && m.items.length > 0);
      localStorage.setItem(storageKey, JSON.stringify(meals));
      currentLogs = meals;
    } catch (err) {}
  }

  filterAndRenderSelectedDate();

  if (currentUserHandle && window.MacromixFirebase && parentMealId) {
    try {
      if (updatedParentMeal) {
        await window.MacromixFirebase.saveMealToFirestore(currentUserHandle, updatedParentMeal);
      } else {
        await window.MacromixFirebase.deleteMealFromFirestore(currentUserHandle, parentMealId);
      }
    } catch (err) {
      console.warn('[macromix] Firestore meal deletion sync notice:', err);
    }
  }

  AppLogger.log('UI', `Food item #${itemId} deleted successfully`);
}

async function deleteMealLog(logId) {
  if (isVisitorMode) return;
  if (!confirm("Are you sure you want to delete this meal log?")) return;
  AppLogger.log('UI', `User initiated deletion of meal log #${logId}`);
  if (isLocalBackend()) {
    try {
      const res = await fetch(`/api/logs/${logId}`, { method: 'DELETE' });
      if (res.ok) {
        await AppLogger.fetchBackendLogs();
      }
    } catch (e) {}
  }

  const storageKey = getMealsStorageKey(currentUserHandle);
  let stored = localStorage.getItem(storageKey);
  if (stored) {
    try {
      let meals = JSON.parse(stored).filter(m => m.id !== logId);
      localStorage.setItem(storageKey, JSON.stringify(meals));
      currentLogs = meals;
    } catch (err) {}
  }

  filterAndRenderSelectedDate();

  if (currentUserHandle && window.MacromixFirebase) {
    try {
      await window.MacromixFirebase.deleteMealFromFirestore(currentUserHandle, logId);
    } catch (err) {
      console.warn('[macromix] Firestore meal deletion sync notice:', err);
    }
  }

  AppLogger.log('UI', `Meal log #${logId} deleted successfully`);
}

// --- Text Logging Fallback ---
async function handleTextLog(e) {
  e.preventDefault();
  const submitBtn = document.getElementById('btn-submit-log');
  if (isProcessingLog || (submitBtn && submitBtn.disabled)) {
    console.warn("[macronomics] Blocked 2nd click on Log CTA during in-flight processing.");
    return;
  }
  const text = manualTextInput.value.trim();
  if (!text) {
    setMicStatus("Please enter what you ate (e.g. '100g chicken').", true);
    manualTextInput.focus();
    return;
  }

  AppLogger.log('UI', `User submitted text meal log via Log button`, {
    transcript: text,
    engine: currentEngine
  });

  // Synchronous immediate lock before any async microtask
  isProcessingLog = true;
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.classList.add('btn-logging');
    submitBtn.style.pointerEvents = 'none';
  }
  if (btnTapRecord) {
    btnTapRecord.disabled = true;
    btnTapRecord.classList.add('btn-disabled');
    btnTapRecord.style.pointerEvents = 'none';
  }

  manualTextInput.disabled = true;
  manualTextInput.placeholder = 'Logging meal...';

  try {
    const success = await processTranscript(text, null, 'text');
    if (success && manualTextInput && manualTextInput.value === text) {
      manualTextInput.value = '';
    }
  } catch (err) {
    // Retain input text in manualTextInput on error
  } finally {
    isProcessingLog = false;
    if (manualTextInput) {
      manualTextInput.disabled = false;
      manualTextInput.placeholder = 'Or type e.g. 200g veg pulao and some veggies';
    }
    if (submitBtn) {
      submitBtn.classList.remove('btn-logging');
      submitBtn.innerHTML = '<span class="btn-log-text">Log</span> <svg class="btn-log-bolt-svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>';
    }
    updateLogButtonState();
    if (btnTapRecord) {
      btnTapRecord.disabled = false;
      btnTapRecord.classList.remove('btn-disabled');
      btnTapRecord.style.pointerEvents = 'auto';
    }
  }
}

// --- Gemini Client Fallback & Processing Pipeline ---
const GEMINI_SYSTEM_PROMPT = `You are a high-precision nutritional voice assistant.
CRITICAL INSTRUCTION: Analyze the audio or text carefully.
1. If the input is conversational speech, questions, commands, background chatter, or does NOT describe actual food or drink consumed (for example: "we will not take one hour to search for a movie", "hello", "play music", "turn on lights"), you MUST set "is_food": false and "items": [].
2. If and only if the input mentions edible food or beverages consumed, set "is_food": true, transcribe what was eaten, extract each food item entity, and compute precise macronutrients (calories, protein, carbs, fat, fiber).
3. If an input lists multiple foods or describes a composite dish with distinct specified ingredient portions (for example: "chicken biryani with 300g rice and 100g chicken", "salad with 150g chicken and 2 tbsp dressing", "150g chicken, 250g rice, 10 pistas, 15 almonds"), you MUST itemize each distinct component ingredient with its portion as a separate item in the "items" array (e.g. "biryani rice" 300g, "chicken" 100g, "pistachios" 10, "almonds" 15).

Output strictly a JSON object with this structure:
{
  "raw_transcript": string,
  "is_food": boolean,
  "meal_type": "breakfast" | "lunch" | "dinner" | "snack",
  "logged_time": "HH:MM" or null,
  "items": [
    {
      "food_name": string,
      "preparation_state": string,
      "quantity": float,
      "unit": string,
      "standardized_weight_g": float,
      "fdc_id": integer,
      "description": string,
      "calories": float,
      "protein_g": float,
      "carbs_g": float,
      "fat_g": float,
      "fiber_g": float
    }
  ],
  "total_calories": float,
  "total_protein_g": float,
  "total_carbs_g": float,
  "total_fat_g": float,
  "total_fiber_g": float
}`;

async function callClientGeminiDirect(transcript, audioBase64 = null) {
  const apiKey = getEffectiveGeminiKey();
  if (!apiKey) {
    throw new Error("Gemini API key is not configured. Please ensure env.js is loaded.");
  }
  const t0 = performance.now();

  const modelsToTry = [
    'gemini-flash-latest',
    'gemini-3.8-flash'
  ];

  const parts = [];
  if (audioBase64) {
    parts.push({
      inlineData: {
        mimeType: 'audio/webm',
        data: audioBase64
      }
    });
  }
  if (transcript) {
    parts.push({ text: transcript });
  } else {
    parts.push({ text: "Please transcribe the audio and calculate exact macronutrients in JSON." });
  }

  const payload = {
    contents: [{ parts: parts }],
    systemInstruction: { parts: [{ text: GEMINI_SYSTEM_PROMPT }] },
    generationConfig: {
      responseMimeType: "application/json",
      thinkingConfig: { thinkingBudget: 0 }
    }
  };

  let geminiResult = null;
  let lastErr = null;

  for (const model of modelsToTry) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const contentType = res.headers.get('content-type') || '';
      if (res.ok && contentType.includes('application/json')) {
        const data = await res.json();
        const candidate = data.candidates?.[0];
        if (candidate?.content?.parts) {
          for (const p of candidate.content.parts) {
            if (p.text) {
              let clean = p.text.trim();
              if (clean.startsWith('```')) {
                clean = clean.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
              }
              geminiResult = JSON.parse(clean);
              break;
            }
          }
        }
        if (geminiResult) {
          AppLogger.log('GEMINI', `Gemini (${model}) processed meal successfully`, {
            is_food: geminiResult.is_food,
            item_count: (geminiResult.items || []).length
          });
          break;
        }
      } else {
        const errText = await res.text().catch(() => '');
        // Strip out HTML tags (e.g. 404 pages) to prevent raw HTML in UI alerts
        const cleanErr = errText.replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim();
        lastErr = new Error(`HTTP ${res.status}: ${cleanErr.slice(0, 100) || res.statusText}`);
      }
    } catch (e) {
      lastErr = e;
    }
  }

  if (!geminiResult) {
    if (window.MacromixFirebase && typeof window.MacromixFirebase.recordGeminiTelemetry === 'function') {
      window.MacromixFirebase.recordGeminiTelemetry(Math.round(performance.now() - t0), false);
    }
    const safeMsg = lastErr ? (lastErr.message || '').replace(/<[^>]*>?/gm, '').trim() : '';
    throw new Error(safeMsg || "Gemini AI is currently busy. Please wait a few moments and try again.");
  }

  const latencyMs = Math.round(performance.now() - t0);
  if (window.MacromixFirebase && typeof window.MacromixFirebase.recordGeminiTelemetry === 'function') {
    window.MacromixFirebase.recordGeminiTelemetry(latencyMs, true);
  }

  return geminiResult;
}

async function processTranscript(transcript, audioBase64 = null, inputSource = 'voice') {
  if (isVisitorMode) return;
  if ((!transcript || !transcript.trim()) && !audioBase64) {
    setMicStatus("Please speak or enter what you ate.", true);
    AppLogger.log('UI', 'Log request cancelled: transcript and audio were empty');
    return false;
  }

  const submitBtn = document.getElementById('btn-submit-log');
  const alreadyLocked = isProcessingLog;
  if (!alreadyLocked) {
    isProcessingLog = true;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.classList.add('btn-logging');
      submitBtn.style.pointerEvents = 'none';
    }
    if (btnTapRecord) {
      btnTapRecord.disabled = true;
      btnTapRecord.classList.add('btn-disabled');
      btnTapRecord.style.pointerEvents = 'none';
    }
    manualTextInput.disabled = true;
  }

  setMicStatus("Analyzing meal with Gemini AI...");
  AppLogger.log('UI', 'Starting pipeline via Gemini AI', {
    transcript: transcript || '',
    hasAudio: !!audioBase64,
    audioLengthBytes: audioBase64 ? audioBase64.length : 0
  });

  try {
    let geminiData = null;
    let fallbackToClient = !isLocalBackend();

    if (isLocalBackend()) {
      try {
        AppLogger.log('GEMINI', 'Sending request to POST /api/gemini/multimodal', {
          prompt: transcript,
          audio_included: !!audioBase64,
          user_id: 1
        });

        const res = await fetch('/api/gemini/multimodal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            audio_base64: audioBase64,
            text_prompt: transcript,
            user_id: 1
          })
        });

        await AppLogger.fetchBackendLogs();

        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
          fallbackToClient = true;
        } else if (res.status === 403) {
          const errData = await res.json().catch(() => ({}));
          AppLogger.log('GEMINI', 'API key required (403). Prompting for custom API key', errData, 'WARN');
          openGeminiModal();
          setMicStatus(errData.message || "Gemini API key required. Click Gemini badge to configure.", true);
          return false;
        } else if (res.status === 422) {
          const errData = await res.json().catch(() => ({}));
          AppLogger.log('GEMINI', 'Non-food input rejected by LLM gate (422)', errData, 'WARN');
          setMicStatus(errData.message || "No food items detected. Please specify what you ate.", true);
          return false;
        } else if (res.status === 502 || res.status === 503) {
          const errData = await res.json().catch(() => ({}));
          AppLogger.log('GEMINI', `Gemini unavailable (${res.status})`, errData, 'WARN');
          setMicStatus(errData.message || "Gemini AI is currently busy. Please wait a few minutes and try again. 🙏", true);
          return false;
        } else if (res.status === 404 || !res.ok) {
          fallbackToClient = true;
        } else {
          geminiData = await res.json().catch(() => null);
          if (!geminiData) fallbackToClient = true;
        }
      } catch (fetchErr) {
        fallbackToClient = true;
      }
    }

    if (fallbackToClient) {
      AppLogger.log('GEMINI', 'Running client-side Gemini AI direct inference.');
      try {
        geminiData = await callClientGeminiDirect(transcript, audioBase64);
      } catch (clientErr) {
        AppLogger.log('GEMINI', `Client-side Gemini failed: ${clientErr.message}`, null, 'WARN');
        const cleanMsg = (clientErr.message || 'Gemini service unavailable').replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim();
        setMicStatus(`Could not analyze meal: ${cleanMsg}`, true);
        return false;
      }
      if (!geminiData) return false;
    }

    AppLogger.log('GEMINI', `Gemini returned ${geminiData.items ? geminiData.items.length : 0} items for meal`, geminiData);

    if (geminiData.is_food === false || !geminiData.items || geminiData.items.length === 0) {
      setMicStatus(geminiData.message || "No food items detected. Please specify what you ate.", true);
      return false;
    }

    const targetDate = (selectedDate && selectedDate <= getTodayDateString()) ? selectedDate : getTodayDateString();

    // Save meal via backend POST /api/logs if local server is active, else directly via client storage & Firestore
    let savedToBackend = false;
    if (isLocalBackend()) {
      try {
        AppLogger.log('SQL', 'Saving Gemini meal via POST /api/logs', {
          meal_type: geminiData.meal_type || 'snack',
          item_count: geminiData.items.length,
          logged_date: targetDate
        });

        const saveRes = await fetch('/api/logs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            meal_type: geminiData.meal_type || 'snack',
            logged_time: geminiData.logged_time,
            raw_transcript: geminiData.raw_transcript || transcript || "",
            engine_used: 'gemini_multimodal_ai',
            logged_date: targetDate,
            items: geminiData.items
          })
        });

        const saveContentType = saveRes.headers.get('content-type') || '';
        if (saveRes.ok && saveContentType.includes('application/json')) {
          savedToBackend = true;
          try {
            const savedMeal = await saveRes.json();
            if (savedMeal && savedMeal.id) {
              const storageKey = getMealsStorageKey(currentUserHandle);
              const stored = localStorage.getItem(storageKey);
              let meals = stored ? JSON.parse(stored) : [];
              meals = meals.filter(m => String(m.id) !== String(savedMeal.id));
              meals.unshift(savedMeal);
              localStorage.setItem(storageKey, JSON.stringify(meals));
              currentLogs = meals;
              if (currentUserHandle && window.MacromixFirebase && typeof window.MacromixFirebase.saveMealToFirestore === 'function') {
                window.MacromixFirebase.saveMealToFirestore(currentUserHandle, savedMeal);
              }
            }
          } catch (jErr) {}
          await AppLogger.fetchBackendLogs();
        }
      } catch (e) {}
    }

    if (!savedToBackend) {
      // Direct client-side save to localStorage
      const storageKey = getMealsStorageKey(currentUserHandle);
      const stored = localStorage.getItem(storageKey);
      let meals = stored ? JSON.parse(stored) : [];
      const newId = Date.now();
      const itemsWithIds = (geminiData.items || []).map((it, idx) => ({
        id: newId + idx + 1,
        food_name: it.food_name || 'Food Item',
        preparation_state: it.preparation_state || 'standard',
        quantity: it.quantity || 1,
        unit: it.unit || 'serving',
        standardized_weight_g: it.standardized_weight_g || 100,
        calories: Number(it.calories) || 0,
        protein_g: Number(it.protein_g) || 0,
        carbs_g: Number(it.carbs_g) || 0,
        fat_g: Number(it.fat_g) || 0,
        fiber_g: Number(it.fiber_g) || 0
      }));
      const now = new Date();
      const mealTotalCal = itemsWithIds.reduce((sum, it) => sum + (Number(it.calories) || 0), 0);
      const mealTotalProt = itemsWithIds.reduce((sum, it) => sum + (Number(it.protein_g) || 0), 0);
      const mealTotalCarb = itemsWithIds.reduce((sum, it) => sum + (Number(it.carbs_g) || 0), 0);
      const mealTotalFiber = itemsWithIds.reduce((sum, it) => sum + (Number(it.fiber_g) || 0), 0);
      const mealTotalFat = itemsWithIds.reduce((sum, it) => sum + (Number(it.fat_g) || 0), 0);

      const newMeal = {
        id: newId,
        owner_handle: currentUserHandle || '',
        meal_type: geminiData.meal_type || 'snack',
        logged_date: targetDate,
        created_at: targetDate === getTodayDateString() ? now.toISOString() : `${targetDate}T12:00:00.000Z`,
        logged_time: geminiData.logged_time || now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        raw_transcript: geminiData.raw_transcript || transcript || "",
        engine_used: 'gemini_multimodal_ai',
        input_source: inputSource,
        items: itemsWithIds,
        total_calories: Math.round(mealTotalCal * 10) / 10,
        total_protein_g: Math.round(mealTotalProt * 10) / 10,
        total_carbs_g: Math.round(mealTotalCarb * 10) / 10,
        total_fiber_g: Math.round(mealTotalFiber * 10) / 10,
        total_fat_g: Math.round(mealTotalFat * 10) / 10
      };
      meals.unshift(newMeal);
      localStorage.setItem(storageKey, JSON.stringify(meals));
      currentLogs = meals;
      filterAndRenderSelectedDate();
      AppLogger.log('UI', 'Meal saved to client storage', newMeal);

      if (currentUserHandle && window.MacromixFirebase && typeof window.MacromixFirebase.saveMealToFirestore === 'function') {
        window.MacromixFirebase.saveMealToFirestore(currentUserHandle, newMeal);
      }
    }

    // Ensure selectedDate stays on targetDate so user immediately sees their logged meal
    selectedDate = targetDate;
    updateDateLabel();
    await loadGeminiStatus();
    await loadMealLogs();
    await AppLogger.fetchBackendLogs();
    renderStreak();
    setMicStatus("Meal logged successfully! 🎯");
    AppLogger.log('UI', 'Meal pipeline finished successfully! 🎯');
    checkAndTriggerInstallBanner(true);
    setTimeout(() => {
      setMicStatus("Mic Idle • Ready to Record");
    }, 2500);

    // Clear and unlock text input on successful log
    if (manualTextInput) {
      manualTextInput.value = '';
      manualTextInput.disabled = false;
      manualTextInput.placeholder = 'Or type e.g. 200g veg pulao and some veggies';
    }
    updateLogButtonState();
    return true;
  } catch (err) {
    console.error("Logging error:", err);
    let msg = err.message || "Error logging meal. Please try again.";
    if (msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("abort")) {
      msg = "Could not connect to Gemini AI or server. Please verify your connection or Gemini API key.";
    }
    setMicStatus(`Error: ${msg}`, true);
    AppLogger.log('ERROR', `Pipeline error: ${msg}`, { error: String(err) }, 'ERROR');
    await AppLogger.fetchBackendLogs().catch(() => {});
    return false;
  } finally {
    isProcessingLog = false;
    if (manualTextInput) {
      manualTextInput.disabled = false;
      manualTextInput.placeholder = 'Or type e.g. 200g veg pulao and some veggies';
    }
    if (submitBtn) {
      submitBtn.classList.remove('btn-logging');
      submitBtn.innerHTML = '<span class="btn-log-text">Log</span> <svg class="btn-log-bolt-svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>';
    }
    updateLogButtonState();
    if (btnTapRecord) {
      btnTapRecord.disabled = false;
      btnTapRecord.classList.remove('btn-disabled');
      btnTapRecord.style.pointerEvents = 'auto';
    }
  }
}

// --- Web Audio API Recording Pipeline (FR-101) ---
async function toggleVoiceRecording() {
  if (isRecording) {
    stopRecording();
  } else {
    await startRecording();
  }
}

function startPTT() {
  if (!isRecording) {
    startRecording();
  }
}

function stopPTT() {
  if (isRecording) {
    stopRecording();
  }
}

function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return null;
  const sr = new SpeechRecognition();
  sr.continuous = true;
  sr.interimResults = true;
  sr.lang = 'en-US';

  sr.onresult = (event) => {
    if (isProcessingLog) return;
    // KEY FIX: Chrome and Safari reset event.results on each new utterance when
    // the recognition engine restarts internally (which happens on natural pauses
    // with continuous=true). Iterating from 0 therefore still only sees the current
    // sentence. Instead, we append ONLY the NEW finalized segments (event.resultIndex
    // to end) into liveTranscript, which IS persistent across all callbacks and is
    // reset to '' at the start of each recording session in startRecording().
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        liveTranscript = (liveTranscript + ' ' + event.results[i][0].transcript).trim();
      }
    }

    // Append interim (in-progress) results for real-time preview only
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (!event.results[i].isFinal) {
        interim += event.results[i][0].transcript;
      }
    }

    const combined = (liveTranscript + (interim ? ' ' + interim : '')).trim();
    if (combined && !isProcessingLog) {
      setMicStatus(`🗣️ "${combined}"`);
      if (liveTranscript) {
        AppLogger.log('UI', `Speech recognition transcript (accumulated): "${liveTranscript}"`, { accumulated: liveTranscript, interim: interim.trim() });
      }
    }
  };

  sr.onerror = (e) => {
    console.warn("[SpeechRecognition]", e.error);
    AppLogger.log('UI', `Speech recognition event: ${e.error}`);
  };

  return sr;
}

async function startRecording() {
  if (isProcessingLog) return;
  AppLogger.log('UI', 'User started microphone recording');
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    AppLogger.log('ERROR', 'Microphone permission denied or not available', { error: String(e) }, 'ERROR');
    alert("Microphone permission denied or not available. Please allow mic access or use text input.");
    return;
  }

  isRecording = true;
  liveTranscript = '';
  btnTapRecord.classList.add('recording');
  btnTapRecord.textContent = '⏹️ Stop Recording';
  setMicStatus('Listening... Speak food item & portion');

  if (!speechRecognition) {
    speechRecognition = initSpeechRecognition();
  }
  if (speechRecognition) {
    try { speechRecognition.start(); } catch (e) {}
  }

  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioContext.createMediaStreamSource(micStream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);

  startAudioVolumeTracker();

  audioChunks = [];
  mediaRecorder = new MediaRecorder(micStream);
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) audioChunks.push(e.data);
  };

  mediaRecorder.onstop = async () => {
    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
    stopAudioVolumeTracker();

    const capturedTranscript = liveTranscript.trim();

    if (isProcessingLog) return;

    // Convert blob to base64
    const reader = new FileReader();
    reader.readAsDataURL(audioBlob);
    reader.onloadend = async () => {
      const base64Audio = reader.result.split(',')[1];
      await processRecordedAudio(base64Audio, capturedTranscript);
    };
  };

  mediaRecorder.start();

  // Auto-silence cut-off after 5s
  resetSilenceTimer();
}

function stopRecording() {
  if (!isRecording) return;
  AppLogger.log('UI', 'User stopped microphone recording');
  isRecording = false;
  btnTapRecord.classList.remove('recording');
  btnTapRecord.innerHTML = '<span class="btn-mic-icon">🎙️</span><span class="btn-track-text">Track your macro<span class="btn-brand-mix">mix</span></span>';

  if (silenceTimer) clearTimeout(silenceTimer);

  if (speechRecognition) {
    try { speechRecognition.stop(); } catch (e) {}
  }

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  if (micStream) {
    micStream.getTracks().forEach(track => track.stop());
  }
}

async function processRecordedAudio(audioBase64, capturedTranscript = "") {
  setMicStatus('Analyzing voice...');
  
  const textToUse = (capturedTranscript || "").trim();
  if (textToUse) {
    await processTranscript(textToUse, null);
    return;
  }

  // Fallback if browser SpeechRecognition was not available
  if (currentEngine === 'gemini') {
    await processTranscript("", audioBase64);
  } else {
    try {
      const res = await fetch('/api/audio/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio_base64: audioBase64 })
      });
      const data = await res.json();
      await processTranscript(data.transcript || (manualTextInput ? manualTextInput.value.trim() : "") || "");
    } catch (e) {
      await processTranscript((manualTextInput ? manualTextInput.value.trim() : "") || "");
    }
  }
}

// Silence Detection via Web Audio API (visualizer canvas removed)
function startAudioVolumeTracker() {
  if (!analyser) return;
  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  function checkVolume() {
    visualizerAnimationId = requestAnimationFrame(checkVolume);
    analyser.getByteFrequencyData(dataArray);

    let volumeSum = 0;
    for (let i = 0; i < bufferLength; i++) {
      volumeSum += dataArray[i];
    }

    const avgVolume = volumeSum / bufferLength;
    if (avgVolume > 12) {
      resetSilenceTimer();
    }
  }

  checkVolume();
}

function stopAudioVolumeTracker() {
  if (visualizerAnimationId) {
    cancelAnimationFrame(visualizerAnimationId);
    visualizerAnimationId = null;
  }
}

function resetSilenceTimer() {
  if (silenceTimer) clearTimeout(silenceTimer);
  silenceTimer = setTimeout(() => {
    if (isRecording) {
      setMicStatus("Auto-silence cut-off (5s)");
      stopRecording();
    }
  }, 5000);
}

// --- Settings Modal ---
function setupSettingsModal() {
  const btn = document.getElementById('open-settings-btn');
  if (btn) btn.onclick = openSettingsModal;

  // Close modals when clicking outside on backdrop
  window.addEventListener('click', (e) => {
    const settingsModal = document.getElementById('settings-modal');
    const editModal = document.getElementById('edit-item-modal');
    if (e.target === settingsModal) closeSettingsModal();
    if (e.target === editModal) closeEditModal();
  });
}

let isAnimatingDeckTransition = false;

function triggerDeckSwipe(offsetDays, direction = null, exitDirection = null) {
  if (offsetDays > 0 && selectedDate >= getTodayDateString()) {
    return; // Cannot go to future past today
  }
  const mainCard = document.getElementById('main-top-card');
  const underCard = document.getElementById('under-top-card');
  const edge1 = document.getElementById('edge-stack-1');
  const edge2 = document.getElementById('edge-stack-2');

  if (isAnimatingDeckTransition || !mainCard || !underCard) {
    changeDate(offsetDays, direction);
    return;
  }

  isAnimatingDeckTransition = true;
  const targetDate = getOffsetDateString(selectedDate, offsetDays);
  updateUnderCard(targetDate);

  // If exitDirection is not provided (e.g. from arrow clicks):
  // Clicking ◀ (prev): card exits to the right so under card surfaces from left/center
  // Clicking ▶ (next): card exits to the left so under card surfaces from right/center
  const exitDir = exitDirection || (offsetDays < 0 ? 'right' : 'left');
  const exitX = exitDir === 'left' ? '-120%' : '120%';
  const rot = exitDir === 'left' ? -10 : 10;

  // Make under card visible and let it surface
  underCard.style.visibility = 'visible';
  underCard.style.opacity = '1';
  underCard.style.transition = 'opacity 0.22s ease';
  mainCard.style.transition = 'transform 0.26s cubic-bezier(0.2, 0.9, 0.3, 1), opacity 0.22s ease-out';

  mainCard.style.transform = `translateX(${exitX}) rotate(${rot}deg)`;
  mainCard.style.opacity = '0';
  underCard.style.transform = 'translateY(0)';

  if (edge1) edge1.style.transform = 'translateX(0)';
  if (edge2) edge2.style.transform = 'translateX(0)';

  setTimeout(() => {
    changeDate(offsetDays, direction || (offsetDays < 0 ? 'prev' : 'next'));

    mainCard.style.transition = 'none';
    underCard.style.transition = 'none';
    mainCard.style.transform = 'translateX(0) rotate(0deg)';
    mainCard.style.opacity = '1';

    // Reset under card to recessed state and hide it at rest
    underCard.style.transform = 'translateY(0)';
    underCard.style.opacity = '0';
    underCard.style.visibility = 'hidden';

    if (edge1) edge1.style.transform = 'translateX(0)';
    if (edge2) edge2.style.transform = 'translateX(0)';

    updateUnderCard(getOffsetDateString(selectedDate, -1));
    isAnimatingDeckTransition = false;
  }, 260);
}

// --- Touch & Mouse Swipe Gestures for Day Navigation with Stacked Card Surfacing ---
function setupSwipeGestures() {
  const stage = document.getElementById('top-card-stage');
  const mainCard = document.getElementById('main-top-card');
  const underCard = document.getElementById('under-top-card');
  const edge1 = document.getElementById('edge-stack-1');
  const edge2 = document.getElementById('edge-stack-2');

  // 1:1 Live Drag Tracking on Top Card Stage
  if (stage && mainCard && underCard) {
    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let isTracking = false;
    let isSwiping = false;
    let preparedTargetDate = null;

    const onStart = (clientX, clientY) => {
      if (isAnimatingDeckTransition) return;
      if (_cardJiggleTimeout) {
        clearTimeout(_cardJiggleTimeout);
        _cardJiggleTimeout = null;
      }
      mainCard.classList.remove('top-card-jiggle');
      startX = clientX;
      startY = clientY;
      startTime = Date.now();
      isTracking = true;
      isSwiping = false;
      preparedTargetDate = null;

      mainCard.style.transition = 'none';
      underCard.style.transition = 'none';
      if (edge1) edge1.style.transition = 'none';
      if (edge2) edge2.style.transition = 'none';
    };

    const onMove = (clientX, clientY, e) => {
      if (!isTracking || isAnimatingDeckTransition) return;
      const dx = clientX - startX;
      const dy = clientY - startY;

      if (!isSwiping) {
        if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 0.7) {
          isSwiping = true;
        } else if (Math.abs(dy) > 20 && Math.abs(dy) > Math.abs(dx) * 1.5) {
          isTracking = false;
          return;
        }
      }

      if (isSwiping) {
        if (e && e.cancelable && e.preventDefault) e.preventDefault();

        const isToday = (selectedDate >= getTodayDateString());
        let neededDate = null;

        if (isToday) {
          // On Today: User CANNOT swipe right-to-left (dx < 0, toward tomorrow)
          if (dx < 0) {
            // Apply rubber-band resistance clamp (maximum ~18px)
            const blockedDx = Math.max(-18, dx * 0.12);
            mainCard.style.transform = `translateX(${blockedDx}px) rotate(${blockedDx * 0.12}deg)`;
            mainCard.classList.add('swipe-blocked');

            // Keep under card strictly hidden
            underCard.style.visibility = 'hidden';
            underCard.style.opacity = '0';
            underCard.style.transform = 'translateY(0)';
            return;
          }

          // Otherwise dragging left-to-right (dx > 0) is valid and reveals Yesterday
          mainCard.classList.remove('swipe-blocked');
          neededDate = getOffsetDateString(selectedDate, -1);
        } else {
          // On past days:
          // dx > 0 (drag right) -> older day (previous)
          // dx < 0 (drag left) -> newer day (next)
          neededDate = (dx > 0) ? getOffsetDateString(selectedDate, -1) : getOffsetDateString(selectedDate, 1);
        }

        if (neededDate && neededDate !== preparedTargetDate) {
          preparedTargetDate = neededDate;
          updateUnderCard(neededDate);
        }

        // Under card becomes visible as user drags
        underCard.style.visibility = 'visible';

        const maxDrag = 180;
        const progress = Math.min(1.0, Math.abs(dx) / maxDrag);
        const rot = (dx / maxDrag) * 7; // subtle rotation up to 7 deg

        mainCard.style.transform = `translateX(${dx}px) rotate(${rot}deg)`;
        underCard.style.transform = 'translateY(0)';
        underCard.style.opacity = Math.min(1, 0.4 + (progress * 0.6)).toFixed(2);

        if (edge1) edge1.style.transform = 'translateX(0)';
        if (edge2) edge2.style.transform = 'translateX(0)';
      }
    };

    const onEnd = (clientX, clientY) => {
      if (!isTracking || isAnimatingDeckTransition) return;
      isTracking = false;
      const dx = clientX - startX;
      const duration = Date.now() - startTime;
      const threshold = 60;
      const isFlick = (Math.abs(dx) >= 30 && duration < 260);
      const isToday = (selectedDate >= getTodayDateString());

      // If user attempted to swipe right-to-left on Today (toward future date)
      if (isToday && dx < 0) {
        mainCard.classList.remove('swipe-blocked');
        mainCard.style.transition = 'transform 0.28s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
        mainCard.style.transform = 'translateX(0) rotate(0deg)';
        underCard.style.opacity = '0';
        underCard.style.visibility = 'hidden';

        if (Math.abs(dx) >= 15) {
          mainCard.classList.add('shake-blocked');
          setTimeout(() => {
            mainCard.classList.remove('shake-blocked');
          }, 350);
        }
        isSwiping = false;
        return;
      }

      if (isSwiping && (Math.abs(dx) >= threshold || isFlick)) {
        if (isToday) {
          // On Today, ONLY swiping left to right (dx > 0) navigates to Yesterday
          if (dx > 0) {
            triggerDeckSwipe(-1, 'prev', 'right');
          }
        } else {
          if (dx > 0) {
            // Dragged right on past day -> go to older day
            triggerDeckSwipe(-1, 'prev', 'right');
          } else {
            // Dragged left on past day -> go to newer day
            triggerDeckSwipe(1, 'next', 'left');
          }
        }
      } else {
        // Cancelled or rubber-band snap back
        mainCard.style.transition = 'transform 0.24s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
        underCard.style.transition = 'opacity 0.22s ease-out';
        if (edge1) edge1.style.transition = 'transform 0.24s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
        if (edge2) edge2.style.transition = 'transform 0.24s cubic-bezier(0.175, 0.885, 0.32, 1.275)';

        mainCard.style.transform = 'translateX(0) rotate(0deg)';
        underCard.style.transform = 'translateY(0)';
        underCard.style.opacity = '0';
        setTimeout(() => {
          if (!isTracking && !isAnimatingDeckTransition) {
            underCard.style.visibility = 'hidden';
          }
        }, 220);

        if (edge1) edge1.style.transform = 'translateX(0)';
        if (edge2) edge2.style.transform = 'translateX(0)';
      }
      isSwiping = false;
    };

    stage.addEventListener('touchstart', (e) => {
      if (e.target.closest('button, input, textarea, a, .rim-btn')) return;
      if (e.touches.length === 1) {
        onStart(e.touches[0].clientX, e.touches[0].clientY);
      }
    }, { passive: true });

    stage.addEventListener('touchmove', (e) => {
      if (e.touches.length === 1) {
        onMove(e.touches[0].clientX, e.touches[0].clientY, e);
      }
    }, { passive: false });

    stage.addEventListener('touchend', (e) => {
      const touch = e.changedTouches && e.changedTouches.length ? e.changedTouches[0] : (e.touches && e.touches.length ? e.touches[0] : null);
      if (touch) {
        onEnd(touch.clientX, touch.clientY);
      } else {
        onEnd(startX, startY);
      }
    }, { passive: true });

    stage.addEventListener('touchcancel', () => {
      isTracking = false;
      isSwiping = false;
      mainCard.style.transform = 'translateX(0) rotate(0deg)';
      underCard.style.transform = 'translateY(0)';
      underCard.style.opacity = '0';
      underCard.style.visibility = 'hidden';
      if (edge1) edge1.style.transform = 'translateX(0)';
      if (edge2) edge2.style.transform = 'translateX(0)';
    });

    // Mouse drag support for testing & desktop convenience
    stage.addEventListener('mousedown', (e) => {
      if (e.target.closest('button, input, textarea, a, .rim-btn')) return;
      onStart(e.clientX, e.clientY);
      const moveHandler = (ev) => onMove(ev.clientX, ev.clientY, ev);
      const upHandler = (ev) => {
        onEnd(ev.clientX, ev.clientY);
        window.removeEventListener('mousemove', moveHandler);
        window.removeEventListener('mouseup', upHandler);
      };
      window.addEventListener('mousemove', moveHandler);
      window.addEventListener('mouseup', upHandler);
    });
  }

  // Also support swiping on the timeline list section
  const timelineSection = document.getElementById('timeline-box-section');
  if (timelineSection) {
    let tStartX = 0;
    let tStartY = 0;
    let tStartTime = 0;

    timelineSection.addEventListener('touchstart', (e) => {
      if (e.target.closest('input, button, textarea, select, .modal-content, a, .action-btn')) return;
      if (e.touches.length === 1) {
        tStartX = e.touches[0].clientX;
        tStartY = e.touches[0].clientY;
        tStartTime = Date.now();
      }
    }, { passive: true });

    timelineSection.addEventListener('touchend', (e) => {
      if (e.changedTouches.length === 1 && tStartTime > 0) {
        const deltaX = e.changedTouches[0].clientX - tStartX;
        const deltaY = e.changedTouches[0].clientY - tStartY;
        const duration = Date.now() - tStartTime;
        tStartTime = 0;

        if (Math.abs(deltaX) >= 50 && Math.abs(deltaX) > Math.abs(deltaY) * 1.2 && duration < 600) {
          const isToday = (selectedDate >= getTodayDateString());
          if (deltaX < 0) {
            // Dragged right to left (toward future)
            if (isToday) {
              // Blocked on Today! Play micro shake
              const mainCard = document.getElementById('main-top-card');
              if (mainCard) {
                mainCard.classList.add('shake-blocked');
                setTimeout(() => mainCard.classList.remove('shake-blocked'), 350);
              }
            } else {
              triggerDeckSwipe(1, 'next', 'left');
            }
          } else {
            // Dragged left to right -> Previous day (Yesterday)
            triggerDeckSwipe(-1, 'prev', 'right');
          }
        }
      }
    }, { passive: true });
  }
}

// --- Empty State Top Card Swipe Discovery Jiggle (Option 2: Tactile Desk Shake) ---
let _cardJiggleTimeout = null;

function triggerEmptyStateCardJiggle(force = false) {
  if (isVisitorMode || (currentTab && currentTab !== 'me')) return;
  if (!force && selectedDate !== getTodayDateString()) return;

  const onboardingEl = document.getElementById('onboarding-screen');
  if (onboardingEl && !onboardingEl.classList.contains('hidden')) return;

  const todayStr = getTodayDateString();
  const todayMeals = currentLogs.filter(l => getLogDate(l) === todayStr);
  if (!force && todayMeals.length > 0) return;

  if (!force && sessionStorage.getItem('macromix_card_jiggle_shown')) return;
  sessionStorage.setItem('macromix_card_jiggle_shown', 'true');

  const card = document.getElementById('main-top-card');
  if (!card) return;

  if (_cardJiggleTimeout) {
    clearTimeout(_cardJiggleTimeout);
  }

  _cardJiggleTimeout = setTimeout(() => {
    card.classList.remove('top-card-jiggle');
    void card.offsetWidth; // force reflow
    card.classList.add('top-card-jiggle');

    card.addEventListener('animationend', () => {
      card.classList.remove('top-card-jiggle');
    }, { once: true });
  }, 450);
}

function openSettingsModal() {
  if (isVisitorMode) {
    // Read-only visitor mode: settings cannot be edited
    return;
  }
  AppLogger.log('UI', 'Opened Daily Macro Targets modal');
  if (userTargets) {
    const calEl = document.getElementById('tgt-input-cal');
    const protEl = document.getElementById('tgt-input-prot');
    const carbEl = document.getElementById('tgt-input-carb');
    const fibEl = document.getElementById('tgt-input-fiber');
    const fatEl = document.getElementById('tgt-input-fat');
    if (calEl && userTargets.calories) calEl.value = userTargets.calories;
    if (protEl && userTargets.protein_g) protEl.value = userTargets.protein_g;
    if (carbEl && userTargets.carbs_g) carbEl.value = userTargets.carbs_g;
    if (fibEl && userTargets.fiber_g !== undefined) fibEl.value = userTargets.fiber_g;
    if (fatEl && userTargets.fat_g) fatEl.value = userTargets.fat_g;
  }

  const handleEl = document.getElementById('settings-account-handle');
  if (handleEl) {
    handleEl.textContent = currentUserHandle ? `@${currentUserHandle}` : '@you';
  }

  const adminSection = document.getElementById('settings-admin-section');
  if (adminSection) {
    adminSection.style.display = (currentUserHandle && currentUserHandle.toLowerCase() === 'satish') ? 'block' : 'none';
  }

  const modal = document.getElementById('settings-modal');
  updateNotificationSettingsUI();
  if (modal) modal.classList.remove('hidden');
}

function closeSettingsModal() {
  AppLogger.log('UI', 'Closed Daily Macro Targets modal');
  const modal = document.getElementById('settings-modal');
  if (modal) modal.classList.add('hidden');
}

// --- Push Notifications & Daily Reminder Engine ---

/**
 * Evaluates whether a daily reminder should be triggered for today.
 * Rule:
 * 1. If 0 meal entries logged today -> shouldRemind = true (reason: 'no_entry')
 * 2. If entries logged today, but user met < 3 of 5 targets at 50% threshold -> shouldRemind = true (reason: 'below_50pct_threshold')
 * 3. If user met >= 3 of 5 targets at 50% threshold -> shouldRemind = false (reason: 'goals_on_track')
 */
function evaluateDailyReminderStatus(todayLogs, targets) {
  const safeTargets = targets || userTargets || { calories: 2000, protein_g: 150, carbs_g: 200, fat_g: 65, fiber_g: 30 };
  const logs = Array.isArray(todayLogs) ? todayLogs : [];

  if (logs.length === 0) {
    return {
      shouldRemind: true,
      reason: 'no_entry',
      metCount: 0,
      totalTargets: 5,
      message: "You haven't logged any meals today yet! Tap to track your macros and keep your streak alive 🔥"
    };
  }

  let totalCal = 0;
  let totalProt = 0;
  let totalCarb = 0;
  let totalFat = 0;
  let totalFiber = 0;

  logs.forEach(log => {
    if (log.items && Array.isArray(log.items) && log.items.length > 0) {
      log.items.forEach(it => {
        totalCal += Number(it.calories) || 0;
        totalProt += Number(it.protein_g) || 0;
        totalCarb += Number(it.carbs_g) || 0;
        totalFat += Number(it.fat_g) || 0;
        totalFiber += Number(it.fiber_g) || 0;
      });
    } else {
      totalCal += Number(log.total_calories) || 0;
      totalProt += Number(log.total_protein_g) || 0;
      totalCarb += Number(log.total_carbs_g) || 0;
      totalFat += Number(log.total_fat_g) || 0;
      totalFiber += Number(log.total_fiber_g) || 0;
    }
  });

  const calTarget = Number(safeTargets.calories) || 2000;
  const protTarget = Number(safeTargets.protein_g) || 150;
  const carbTarget = Number(safeTargets.carbs_g) || 200;
  const fatTarget = Number(safeTargets.fat_g) || 65;
  const fiberTarget = Number(safeTargets.fiber_g !== undefined ? safeTargets.fiber_g : 30) || 30;

  const calMet50 = totalCal >= (0.5 * calTarget);
  const protMet50 = totalProt >= (0.5 * protTarget);
  const carbMet50 = totalCarb >= (0.5 * carbTarget);
  const fatMet50 = totalFat >= (0.5 * fatTarget);
  const fiberMet50 = totalFiber >= (0.5 * fiberTarget);

  const metCount = (calMet50 ? 1 : 0) +
                   (protMet50 ? 1 : 0) +
                   (carbMet50 ? 1 : 0) +
                   (fatMet50 ? 1 : 0) +
                   (fiberMet50 ? 1 : 0);

  if (metCount < 3) {
    return {
      shouldRemind: true,
      reason: 'below_50pct_threshold',
      metCount,
      totalTargets: 5,
      totals: { totalCal, totalProt, totalCarb, totalFat, totalFiber },
      message: `Daily Macro Reminder: You've only reached 50% on ${metCount} of 5 targets today. Tap to log dinner or a snack! 🎯`
    };
  }

  return {
    shouldRemind: false,
    reason: 'goals_on_track',
    metCount,
    totalTargets: 5,
    totals: { totalCal, totalProt, totalCarb, totalFat, totalFiber },
    message: null
  };
}

let dailyReminderSchedulerTimeout = null;

function getStoredReminderTime() {
  return localStorage.getItem('macromix_reminder_time') || '20:00';
}

function isReminderEnabled() {
  return localStorage.getItem('macromix_reminders_enabled') !== 'false';
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function triggerReminderNotification(title, body, url = '/') {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
    return false;
  }

  const options = {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    vibrate: [150, 50, 150],
    data: { url },
    tag: 'macromix-daily-reminder',
    renotify: true
  };

  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.ready;
      if (reg && reg.showNotification) {
        await reg.showNotification(title, options);
        return true;
      }
    }
  } catch (swErr) {
    console.warn('[Macromix Notifications] ServiceWorker showNotification failed:', swErr);
  }

  try {
    new Notification(title, options);
    return true;
  } catch (e) {
    console.warn('[Macromix Notifications] Native Notification failed:', e);
    return false;
  }
}

async function checkAndSendDailyReminder(force = false) {
  if (isVisitorMode) return { sent: false, reason: 'visitor_mode' };

  if (!force) {
    if (!isReminderEnabled()) return { sent: false, reason: 'disabled' };
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
      return { sent: false, reason: 'permission_not_granted' };
    }

    const todayStr = getTodayDateString();
    const lastReminderDate = localStorage.getItem('macromix_last_reminder_date');
    if (lastReminderDate === todayStr) {
      return { sent: false, reason: 'already_sent_today' };
    }

    // Check if current time has reached the scheduled reminder time
    const reminderTime = getStoredReminderTime(); // e.g. "20:00"
    const [remHour, remMin] = reminderTime.split(':').map(Number);
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const targetMinutes = remHour * 60 + (remMin || 0);

    if (currentMinutes < targetMinutes) {
      return { sent: false, reason: 'too_early' };
    }
  }

  const todayStr = getTodayDateString();
  const todayLogs = currentLogs.filter(l => getLogDate(l) === todayStr);
  const status = evaluateDailyReminderStatus(todayLogs, userTargets);

  if (status.shouldRemind || force) {
    const title = 'macromix Daily Reminder 🎯';
    const message = status.message || (force ? "Test notification: Tracking your macros keeps streaks alive! 🔥" : "Don't forget to track your macros today!");
    const sent = await triggerReminderNotification(title, message);

    if (sent && !force) {
      localStorage.setItem('macromix_last_reminder_date', todayStr);
      AppLogger.log('REMINDER', 'Daily reminder notification sent', status);
    }
    return { sent, status };
  }

  return { sent: false, status };
}

function scheduleDailyReminderCheck() {
  if (dailyReminderSchedulerTimeout) {
    clearTimeout(dailyReminderSchedulerTimeout);
    dailyReminderSchedulerTimeout = null;
  }

  if (!isReminderEnabled()) return;

  const reminderTime = getStoredReminderTime();
  const [remHour, remMin] = reminderTime.split(':').map(Number);
  const now = new Date();
  const nextTarget = new Date();
  nextTarget.setHours(remHour, remMin || 0, 0, 0);

  // If already past today, schedule for tomorrow
  if (nextTarget <= now) {
    nextTarget.setDate(nextTarget.getDate() + 1);
  }

  const delayMs = Math.max(1000, nextTarget.getTime() - now.getTime());
  AppLogger.log('REMINDER', `Scheduled daily reminder check in ${Math.round(delayMs / 60000)} minutes`);

  dailyReminderSchedulerTimeout = setTimeout(async () => {
    await checkAndSendDailyReminder();
    scheduleDailyReminderCheck();
  }, delayMs);
}

function setupDailyReminderScheduler() {
  scheduleDailyReminderCheck();
}

async function subscribeWebPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return null;
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const vapidKey = (window.__ENV && window.__ENV.VAPID_PUBLIC_KEY) || 'BN3icagxCDZ-KDirdp3qKQMNG7HJUinT1EbfaifB2hzqMHd25aD_3PrYKxATLgsmCFERFFJlW_C4wGOHNnGfy_c';
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey)
      });
    }

    if (sub && currentUserHandle && window.MacromixFirebase?.savePushSubscription) {
      await window.MacromixFirebase.savePushSubscription(currentUserHandle, sub);
    }

    if ('periodicSync' in reg) {
      try {
        await reg.periodicSync.register('daily-macro-reminder', {
          minInterval: 12 * 60 * 60 * 1000
        });
      } catch (pe) {}
    }

    return sub;
  } catch (err) {
    console.warn('[Macromix Notifications] Push subscribe error:', err);
    return null;
  }
}

function updateNotificationSettingsUI() {
  const statusEl = document.getElementById('settings-notification-status');
  const toggleBtn = document.getElementById('btn-toggle-notifications');
  const timeInput = document.getElementById('settings-reminder-time');

  if (timeInput) {
    timeInput.value = getStoredReminderTime();
  }

  if (typeof Notification === 'undefined') {
    if (statusEl) {
      statusEl.textContent = 'Not supported in this browser';
      statusEl.style.color = '#DC2626';
    }
    if (toggleBtn) toggleBtn.disabled = true;
    return;
  }

  const perm = Notification.permission;
  const enabled = isReminderEnabled();

  if (perm === 'granted') {
    if (statusEl) {
      statusEl.textContent = enabled ? 'Enabled ✓ (Active)' : 'Disabled in app';
      statusEl.style.color = enabled ? '#16A34A' : '#64748B';
    }
    if (toggleBtn) {
      toggleBtn.textContent = enabled ? 'Turn Off Reminders' : 'Turn On Reminders 🔔';
      toggleBtn.style.background = enabled ? '#F1F5F9' : 'var(--fat-color)';
      toggleBtn.style.color = enabled ? '#000' : '#1E293B';
    }
  } else if (perm === 'denied') {
    if (statusEl) {
      statusEl.textContent = 'Blocked in browser permissions ✕';
      statusEl.style.color = '#DC2626';
    }
    if (toggleBtn) {
      toggleBtn.textContent = 'Blocked in Permissions 🔒';
      toggleBtn.disabled = true;
    }
  } else {
    if (statusEl) {
      statusEl.textContent = 'Not enabled yet 🔔';
      statusEl.style.color = '#64748B';
    }
    if (toggleBtn) {
      toggleBtn.textContent = 'Enable Notifications 🔔';
      toggleBtn.style.background = 'var(--cal-color)';
      toggleBtn.style.color = '#000';
    }
  }
}

function setupNotificationSettings() {
  const toggleBtn = document.getElementById('btn-toggle-notifications');
  const timeInput = document.getElementById('settings-reminder-time');
  const feedbackEl = document.getElementById('settings-notification-feedback');

  updateNotificationSettingsUI();

  if (timeInput) {
    timeInput.addEventListener('change', (e) => {
      const val = e.target.value || '20:00';
      localStorage.setItem('macromix_reminder_time', val);
      scheduleDailyReminderCheck();
      if (feedbackEl) {
        feedbackEl.style.display = 'block';
        feedbackEl.style.color = '#16A34A';
        feedbackEl.textContent = `✓ Daily reminder scheduled for ${val}`;
        setTimeout(() => { feedbackEl.style.display = 'none'; }, 3000);
      }
    });
  }

  if (toggleBtn) {
    toggleBtn.addEventListener('click', async () => {
      if (typeof Notification === 'undefined') return;

      if (Notification.permission === 'default') {
        const perm = await Notification.requestPermission();
        if (perm === 'granted') {
          localStorage.setItem('macromix_reminders_enabled', 'true');
          await subscribeWebPush();
          scheduleDailyReminderCheck();
        }
      } else if (Notification.permission === 'granted') {
        const currentlyEnabled = isReminderEnabled();
        localStorage.setItem('macromix_reminders_enabled', currentlyEnabled ? 'false' : 'true');
        if (!currentlyEnabled) {
          await subscribeWebPush();
          scheduleDailyReminderCheck();
        } else if (dailyReminderSchedulerTimeout) {
          clearTimeout(dailyReminderSchedulerTimeout);
        }
      }
      updateNotificationSettingsUI();
      updateTopAnnouncementBanner();
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      checkAndSendDailyReminder();
    }
  });
}

// Expose globally for testing & external harnesses
window.evaluateDailyReminderStatus = evaluateDailyReminderStatus;
window.checkAndSendDailyReminder = checkAndSendDailyReminder;
window.scheduleDailyReminderCheck = scheduleDailyReminderCheck;
window.setupDailyReminderScheduler = setupDailyReminderScheduler;

function openGeminiModal() {
  AppLogger.log('UI', 'Opened Gemini AI Status modal');
  const modal = document.getElementById('gemini-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeGeminiModal() {
  AppLogger.log('UI', 'Closed Gemini AI Status modal');
  const modal = document.getElementById('gemini-modal');
  if (modal) modal.classList.add('hidden');
}

// --- Inline Item Edit Drawer ---
function openEditModal(itemId, foodName, qty, unit, weightG) {
  AppLogger.log('UI', `Opened edit drawer for item #${itemId} (${foodName})`, { itemId, foodName, qty, unit, weightG });
  document.getElementById('edit-item-id').value = itemId;
  document.getElementById('edit-food-name-label').textContent = foodName;
  const numQty = parseFloat(qty) || 1;
  const numWeight = parseFloat(weightG) > 0 ? parseFloat(weightG) : numQty;
  document.getElementById('edit-quantity').value = numQty;
  document.getElementById('edit-unit').value = unit || 'g';
  document.getElementById('edit-weight-g').value = numWeight;

  document.getElementById('edit-item-modal').classList.remove('hidden');
}

function closeEditModal() {
  AppLogger.log('UI', 'Closed edit item modal');
  document.getElementById('edit-item-modal').classList.add('hidden');
}

async function saveItemEdit() {
  if (isVisitorMode) return;
  const itemId = parseInt(document.getElementById('edit-item-id').value, 10);
  const qty = parseFloat(document.getElementById('edit-quantity').value);
  let weightG = parseFloat(document.getElementById('edit-weight-g').value);

  if (!itemId || isNaN(qty) || qty <= 0) {
    alert("Please enter a valid quantity greater than 0.");
    return;
  }
  if (isNaN(weightG) || weightG <= 0) {
    weightG = qty;
  }

  AppLogger.log('UI', `User saving portion edit for item #${itemId}`, { quantity: qty, standardized_weight_g: weightG });
  if (isLocalBackend()) {
    try {
      const res = await fetch(`/api/logs/items/${itemId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quantity: qty, standardized_weight_g: weightG })
      });

      if (res.ok) {
        await AppLogger.fetchBackendLogs();
      }
    } catch (e) {}
  }

  const storageKey = getMealsStorageKey(currentUserHandle);
  let stored = localStorage.getItem(storageKey);
  let editedMeal = null;
  if (stored) {
    try {
      let meals = JSON.parse(stored);
      meals.forEach(m => {
        let hasEdit = false;
        (m.items || []).forEach(it => {
          if (it.id === itemId) {
            const oldWeight = (it.standardized_weight_g && it.standardized_weight_g > 0) ? it.standardized_weight_g : (it.quantity > 0 ? it.quantity : weightG);
            const ratio = oldWeight > 0 ? (weightG / oldWeight) : 1;
            it.quantity = qty;
            it.standardized_weight_g = weightG;
            it.calories = Math.round((it.calories || 0) * ratio * 10) / 10;
            it.protein_g = Math.round((it.protein_g || 0) * ratio * 10) / 10;
            it.carbs_g = Math.round((it.carbs_g || 0) * ratio * 10) / 10;
            it.fiber_g = Math.round((it.fiber_g || 0) * ratio * 10) / 10;
            it.fat_g = Math.round((it.fat_g || 0) * ratio * 10) / 10;
            hasEdit = true;
          }
        });
        if (hasEdit) {
          m.total_calories = Math.round((m.items || []).reduce((s, i) => s + (Number(i.calories) || 0), 0) * 10) / 10;
          m.total_protein_g = Math.round((m.items || []).reduce((s, i) => s + (Number(i.protein_g) || 0), 0) * 10) / 10;
          m.total_carbs_g = Math.round((m.items || []).reduce((s, i) => s + (Number(i.carbs_g) || 0), 0) * 10) / 10;
          m.total_fiber_g = Math.round((m.items || []).reduce((s, i) => s + (Number(i.fiber_g) || 0), 0) * 10) / 10;
          m.total_fat_g = Math.round((m.items || []).reduce((s, i) => s + (Number(i.fat_g) || 0), 0) * 10) / 10;
          m.updated_at = new Date().toISOString();
          editedMeal = m;
        }
      });
      localStorage.setItem(storageKey, JSON.stringify(meals));
      currentLogs = meals;
    } catch (err) {}
  }

  closeEditModal();
  filterAndRenderSelectedDate();

  if (currentUserHandle && window.MacromixFirebase && typeof window.MacromixFirebase.saveMealToFirestore === 'function' && editedMeal) {
    try {
      await window.MacromixFirebase.saveMealToFirestore(currentUserHandle, editedMeal);
    } catch (err) {
      console.warn('[macromix] Firestore meal edit sync error:', err);
    }
  }

  AppLogger.log('UI', `Item #${itemId} portion updated successfully`);
}

// ==========================================================================
// Social, Tab Navigation & Public Profile Sharing Controller
// ==========================================================================

function parseUrlHandle() {
  const path = window.location.pathname.replace(/\/+$/, '');
  if (!path || path === '' || path === '/') return null;
  const match = path.match(/^\/?@?([a-zA-Z0-9_]{3,16})$/);
  if (match) {
    const handle = match[1].toLowerCase();
    const reserved = ['index', 'styles', 'app', 'sw', 'manifest', 'icons', 'api', 'favicon', 'admin'];
    if (!reserved.includes(handle)) {
      return handle;
    }
  }
  return null;
}

let _lastGooActiveEl = null;

function layoutHeaderGoo(activeEl) {
  const gooLead = document.getElementById('goo-lead');
  const gooTail = document.getElementById('goo-tail');
  if (!gooLead || !gooTail || !activeEl) return;

  const offsetLeft = activeEl.offsetLeft;
  const width = activeEl.offsetWidth;

  if (width === 0) return; // not rendered or hidden yet

  if (!_lastGooActiveEl) {
    // Initial placement without transition
    gooLead.style.transition = 'none';
    gooTail.style.transition = 'none';
    gooLead.style.transform = `translateX(${offsetLeft}px)`;
    gooLead.style.width = `${width}px`;
    gooTail.style.transform = `translateX(${offsetLeft}px)`;
    gooTail.style.width = `${width}px`;
    void gooLead.offsetHeight; // flush
    gooLead.style.transition = '';
    gooTail.style.transition = '';
  } else {
    // Both lead and tail travel to the target pill!
    // Lead rushes ahead; Tail lags behind and pulls cleanly out of the previous state!
    gooLead.style.transform = `translateX(${offsetLeft}px)`;
    gooLead.style.width = `${width}px`;
    gooTail.style.transform = `translateX(${offsetLeft}px)`;
    gooTail.style.width = `${width}px`;
  }
  _lastGooActiveEl = activeEl;
}

window.addEventListener('resize', () => {
  const pillFriends = document.getElementById('tab-pill-friends');
  const pillMe = document.getElementById('tab-pill-me');
  const activeEl = (currentTab === 'friends' || isVisitorMode) ? pillFriends : pillMe;
  if (activeEl) {
    layoutHeaderGoo(activeEl);
  }
});

function updateHeaderFriendsBtn() {
  const pillFriends = document.getElementById('tab-pill-friends');
  const pillMe = document.getElementById('tab-pill-me');
  if (!pillFriends || !pillMe) return;

  const friendsIsActive = (currentTab === 'friends') || isVisitorMode;
  const activeEl = friendsIsActive ? pillFriends : pillMe;

  if (friendsIsActive) {
    pillFriends.classList.add('tab-active');
    pillMe.classList.remove('tab-active');
    startMePillBobInterval();
  } else {
    pillMe.classList.add('tab-active');
    pillFriends.classList.remove('tab-active');
    stopMePillBobInterval();
  }

  // Update gooey active indicator
  requestAnimationFrame(() => {
    layoutHeaderGoo(activeEl);
  });
}

let _mePillBobTimer = null;

function _triggerMePillBob() {
  const icon = document.getElementById('me-pill-icon');
  if (!icon) return;
  icon.classList.remove('bob');
  void icon.offsetWidth; // force reflow so animation replays
  icon.classList.add('bob');
  icon.addEventListener('animationend', () => icon.classList.remove('bob'), { once: true });
}

function startMePillBobInterval() {
  if (_mePillBobTimer) return;
  _triggerMePillBob();
  _mePillBobTimer = setInterval(_triggerMePillBob, 5000);
}

function stopMePillBobInterval() {
  if (_mePillBobTimer) {
    clearInterval(_mePillBobTimer);
    _mePillBobTimer = null;
  }
  const icon = document.getElementById('me-pill-icon');
  if (icon) icon.classList.remove('bob');
}

function handleHeaderFriendsClick() {
  if (isVisitorMode) {
    backToFriendsList();
  } else if (currentTab !== 'friends') {
    switchTab('friends');
  }
  // Already on Friends tab — no-op
}

function setVisitorMode(isVisitor, targetHandle = null) {
  clearRealtimeListeners();
  isVisitorMode = !!isVisitor;
  viewedHandle = targetHandle ? targetHandle.toLowerCase().replace(/^@+/, '') : null;

  const visitorBanner = document.getElementById('visitor-banner');
  const targetHandleEl = document.getElementById('visitor-target-handle');
  const visitorStreakPill = document.getElementById('visitor-streak-pill');
  const voiceToolCard = document.getElementById('voice-tool-card');
  const voiceRow = document.querySelector('.voice-buttons-row');
  const micBanner = document.getElementById('mic-status-text');
  const textLogForm = document.getElementById('text-log-form');
  const handleText = document.getElementById('header-handle-text');
  const pillMe = document.getElementById('tab-pill-me');

  // Always show/update the Me pill with 'Me'
  if (handleText) {
    handleText.textContent = 'Me';
  }
  if (pillMe) {
    pillMe.style.display = currentUserHandle ? '' : 'none';
  }

  if (isVisitorMode && viewedHandle) {
    currentLogs = [];
    setCardLoadingState(true);
    renderTimeline();
    document.body.classList.add('is-visitor-mode');
    if (visitorBanner) visitorBanner.classList.remove('hidden');
    if (targetHandleEl) targetHandleEl.textContent = viewedHandle;
    if (visitorStreakPill) {
      visitorStreakPill.textContent = '';
      visitorStreakPill.classList.add('hidden');
    }
    if (voiceToolCard) voiceToolCard.classList.add('hidden');
    if (voiceRow) voiceRow.classList.add('hidden');
    if (micBanner) micBanner.classList.add('hidden');
    if (textLogForm) textLogForm.classList.add('hidden');
    // Header streak ALWAYS displays the logged-in user's streak:
    renderCurrentUserStreak();
  } else {
    document.body.classList.remove('is-visitor-mode');
    if (visitorBanner) visitorBanner.classList.add('hidden');
    if (visitorStreakPill) visitorStreakPill.classList.add('hidden');
    if (voiceToolCard) voiceToolCard.classList.remove('hidden');
    if (voiceRow) voiceRow.classList.remove('hidden');
    if (micBanner) micBanner.classList.remove('hidden');
    if (textLogForm) textLogForm.classList.remove('hidden');
    // Clear visitor meals so they don't linger before owner's logs finish loading
    currentLogs = [];
    setCardLoadingState(true);
    renderTimeline();
    renderCurrentUserStreak();
  }

  updateHeaderFriendsBtn();
  updateWeekendWrappedVisibility();
  updateTopAnnouncementBanner();
}


async function checkUrlRoute() {
  const isHashAdmin = window.location.hash === '#admin';
  const isPathAdmin = window.location.pathname.replace(/\/+$/, '') === '/admin';
  if (isHashAdmin || isPathAdmin) {
    if (currentUserHandle && currentUserHandle.toLowerCase() === 'satish') {
      await switchTab('admin', false);
      return;
    }
  }

  const routeHandle = parseUrlHandle();
  if (routeHandle) {
    if (!currentUserHandle) {
      // Unauthenticated guests must register/create an account first
      sessionStorage.setItem('macromix_pending_share_handle', routeHandle);
      return;
    }
    if (currentUserHandle.toLowerCase() === routeHandle.toLowerCase()) {
      setVisitorMode(false);
      currentTab = 'me';
      const viewMe = document.getElementById('view-me');
      const viewFriends = document.getElementById('view-friends');
      if (viewMe) viewMe.classList.remove('hidden');
      if (viewFriends) viewFriends.classList.add('hidden');
    } else {
      setVisitorMode(true, routeHandle);
      currentTab = 'friends';
      const viewMe = document.getElementById('view-me');
      const viewFriends = document.getElementById('view-friends');
      if (viewMe) viewMe.classList.remove('hidden');
      if (viewFriends) viewFriends.classList.add('hidden');
    }
  } else {
    setVisitorMode(false);
  }
  updateHeaderFriendsBtn();
  updateWeekendWrappedVisibility();
  updateTopAnnouncementBanner();
}


/** Apply CSS slide animation between tab views.
 *  direction: 'to-friends' (Me exits right→left, Friends enters from left)
 *             'to-me'      (Friends exits left→right, Me enters from right)
 */
function animateTabSlide(exitEl, enterEl, direction) {
  if (!exitEl || !enterEl) return;
  const slideClasses = [
    'tab-slide-in-left', 'tab-slide-in-right',
    'tab-slide-out-left', 'tab-slide-out-right'
  ];

  // Clear any lingering animation classes
  [exitEl, enterEl].forEach(el => el.classList.remove(...slideClasses));

  if (direction === 'to-friends') {
    exitEl.classList.add('tab-slide-out-left');
    enterEl.classList.add('tab-slide-in-left');
  } else {
    exitEl.classList.add('tab-slide-out-right');
    enterEl.classList.add('tab-slide-in-right');
  }

  // Clean up after animation completes
  const cleanup = () => {
    exitEl.classList.remove(...slideClasses);
    enterEl.classList.remove(...slideClasses);
  };
  enterEl.addEventListener('animationend', cleanup, { once: true });
}

async function switchTab(tabName, updateUrl = true) {
  const viewMe = document.getElementById('view-me');
  const viewFriends = document.getElementById('view-friends');
  const viewAdmin = document.getElementById('view-admin');
  const scroller = document.getElementById('app-scroll-canvas');
  if (scroller) scroller.scrollTop = 0;

  if (tabName === 'admin') {
    currentTab = 'admin';
    if (viewMe) viewMe.classList.add('hidden');
    if (viewFriends) viewFriends.classList.add('hidden');
    if (viewAdmin) {
      viewAdmin.classList.remove('hidden');
      if (window.MacromixAdmin && typeof window.MacromixAdmin.initAdminDashboard === 'function') {
        window.MacromixAdmin.initAdminDashboard(viewAdmin);
      }
    }
    if (updateUrl) {
      window.location.hash = 'admin';
    }
    return;
  }

  // If leaving admin tab, tear down listener and hide
  if (viewAdmin) {
    viewAdmin.classList.add('hidden');
    if (window.MacromixAdmin && typeof window.MacromixAdmin.destroyAdminDashboard === 'function') {
      window.MacromixAdmin.destroyAdminDashboard();
    }
  }

  if (tabName === 'friends') {
    currentTab = 'friends';

    // If user clicks Friends while viewing a friend's profile, go back to friends list!
    if (isVisitorMode) {
      window.history.pushState(null, '', '/');
      setVisitorMode(false);
      if (viewMe) viewMe.classList.add('hidden');
      if (viewFriends) viewFriends.classList.remove('hidden');
      refreshFriendsView();
      updateHeaderFriendsBtn();
  updateWeekendWrappedVisibility();
  updateTopAnnouncementBanner();
      return;
    }

    if (viewMe) viewMe.classList.add('hidden');
    if (viewFriends) viewFriends.classList.remove('hidden');
    refreshFriendsView();
    updateHeaderFriendsBtn();
  updateWeekendWrappedVisibility();
  updateTopAnnouncementBanner();
  } else {
    // Switching to 'me'
    currentTab = 'me';

    if (isVisitorMode) {
      window.history.pushState(null, '', '/');
      setVisitorMode(false);
      if (currentUserHandle) {
        setupRealtimeMealsSync();
        setupCurrentUserProfileSync();
        await loadTargets();
        await loadMealLogs();
        renderStreak();
      }
    }

    if (viewMe) viewMe.classList.remove('hidden');
    if (viewFriends) viewFriends.classList.add('hidden');
    updateHeaderFriendsBtn();
  updateWeekendWrappedVisibility();
  updateTopAnnouncementBanner();
  }
}


async function viewFriendProfile(friendHandle) {
  if (!friendHandle) return;
  const clean = friendHandle.trim().toLowerCase().replace(/^@+/, '');
  window.history.pushState(null, '', '/@' + clean);

  if (currentUserHandle && currentUserHandle.toLowerCase() === clean) {
    // Viewing yourself -> go to 'me' tab
    setVisitorMode(false);
    await switchTab('me', false);
  } else {
    // Viewing a friend -> stay in 'friends' tab!
    setVisitorMode(true, clean);
    currentTab = 'friends';
    const viewMe = document.getElementById('view-me');
    const viewFriends = document.getElementById('view-friends');

    if (viewMe) viewMe.classList.remove('hidden');
    if (viewFriends) viewFriends.classList.add('hidden');
  }

  await loadTargets();
  await loadMealLogs();
  setupRealtimeMealsSync();
  setupRealtimeProfileSync();
  updateHeaderFriendsBtn();
  updateWeekendWrappedVisibility();
  updateTopAnnouncementBanner();
}

async function exitVisitorMode() {
  window.history.pushState(null, '', '/');
  setVisitorMode(false);
  await switchTab('me', false);
  if (currentUserHandle) {
    setupRealtimeMealsSync();
    setupCurrentUserProfileSync();
    await loadTargets();
    await loadMealLogs();
    renderStreak();
  } else {
    const onboardingEl = document.getElementById('onboarding-screen');
    if (onboardingEl) {
      onboardingEl.classList.remove('hidden');
      document.body.style.overflow = 'hidden';
    }
  }
  updateHeaderFriendsBtn();
  updateWeekendWrappedVisibility();
  updateTopAnnouncementBanner();
}

async function backToFriendsList() {
  window.history.pushState(null, '', '/');
  setVisitorMode(false);
  await switchTab('friends', false);
  updateHeaderFriendsBtn();
  updateWeekendWrappedVisibility();
  updateTopAnnouncementBanner();
}

async function triggerProfileShare() {
  const handleToShare = currentUserHandle || 'you';
  const shareUrl = `${window.location.origin}/@${handleToShare}`;
  const shareData = {
    title: 'macromix',
    text: `Check out my daily macros on macromix: @${handleToShare}`,
    url: shareUrl
  };

  if (navigator.share) {
    try {
      await navigator.share(shareData);
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }

  try {
    await navigator.clipboard.writeText(shareUrl);
    alert(`Profile link copied to clipboard!\n${shareUrl}`);
  } catch (err) {
    prompt("Copy your profile link:", shareUrl);
  }
}

async function initFriendsView() {
  const shareUrlEl = document.getElementById('friends-share-url');
  if (shareUrlEl) {
    shareUrlEl.textContent = `${window.location.host}/@${currentUserHandle || 'you'}`;
  }

  if (currentUserHandle && window.MacromixFirebase && typeof window.MacromixFirebase.subscribeFollowing === 'function') {
    if (unsubscribeFollowingListener) {
      try { unsubscribeFollowingListener(); } catch (e) {}
      unsubscribeFollowingListener = null;
    }
    unsubscribeFollowingListener = window.MacromixFirebase.subscribeFollowing(currentUserHandle, (handles) => {
      followingListCache = new Set(handles);
      renderFollowingList();
    });
  }
}

async function refreshFriendsView() {
  const shareUrlEl = document.getElementById('friends-share-url');
  if (shareUrlEl) {
    shareUrlEl.textContent = `${window.location.host}/@${currentUserHandle || 'you'}`;
  }

  if (currentUserHandle && window.MacromixFirebase && typeof window.MacromixFirebase.getFollowingList === 'function') {
    const list = await window.MacromixFirebase.getFollowingList(currentUserHandle);
    followingListCache = new Set(list);
    renderFollowingList();
  }
}

async function handleFriendSearch(query) {
  const q = (query || '').trim().toLowerCase().replace(/^@+/, '');
  const resultsContainer = document.getElementById('friends-search-results');
  if (!resultsContainer) return;

  if (!q) {
    resultsContainer.classList.add('hidden');
    resultsContainer.innerHTML = '';
    return;
  }

  resultsContainer.classList.remove('hidden');
  resultsContainer.innerHTML = '<div class="empty-state">Searching...</div>';

  const isCacheExpired = !allFirestoreUsersCache || (Date.now() - allFirestoreUsersCacheTime > USERS_CACHE_TTL_MS);
  if (isCacheExpired && window.MacromixFirebase && typeof window.MacromixFirebase.getAllFirestoreUsers === 'function') {
    allFirestoreUsersCache = await window.MacromixFirebase.getAllFirestoreUsers();
    allFirestoreUsersCacheTime = Date.now();
  }

  const users = allFirestoreUsersCache || [];
  let matches = users.filter(u => u && u.handle && u.handle.toLowerCase().includes(q) && u.handle.toLowerCase() !== (currentUserHandle || '').toLowerCase());

  // If no matches found in cached list, query Firestore directly for the exact handle
  if (matches.length === 0 && window.MacromixFirebase && typeof window.MacromixFirebase.getFirestoreUserProfile === 'function') {
    try {
      const directUser = await window.MacromixFirebase.getFirestoreUserProfile(q);
      if (directUser && directUser.handle && directUser.handle.toLowerCase() !== (currentUserHandle || '').toLowerCase()) {
        matches = [directUser];
        if (allFirestoreUsersCache) {
          const exists = allFirestoreUsersCache.some(u => u.handle.toLowerCase() === directUser.handle.toLowerCase());
          if (!exists) allFirestoreUsersCache.push(directUser);
        }
      }
    } catch (e) {
      console.warn('[macromix] Direct user lookup notice:', e);
    }
  }

  if (matches.length === 0) {
    resultsContainer.innerHTML = `<div class="empty-state">No users found matching "@${escapeHtml(q)}"</div>`;
    return;
  }

  let html = '';
  matches.forEach(u => {
    const isFollowing = followingListCache.has(u.handle);
    const initial = (u.handle[0] || 'M').toUpperCase();
    const streak = typeof u.streak === 'number' ? u.streak : 0;
    html += `
      <div class="friend-card" id="search-friend-${u.handle}">
        <div class="friend-card-left" onclick="viewFriendProfile('${escapeHtml(u.handle)}')">
          <div class="friend-avatar-badge">${initial}</div>
          <div class="friend-card-meta">
            <span class="friend-card-handle">${escapeHtml(u.handle)}</span>
            <span class="friend-card-streak">🔥 ${streak}d streak</span>
          </div>
        </div>
        <div class="friend-card-actions">
          <button type="button" class="btn-friend-action btn-macromix" onclick="viewFriendProfile('${escapeHtml(u.handle)}')">macromix</button>
          <button type="button" class="btn-friend-action btn-follow ${isFollowing ? 'following' : ''}" onclick="toggleFollowUser('${escapeHtml(u.handle)}', this)">
            ${isFollowing ? '✓ Following' : '+ Follow'}
          </button>
        </div>
      </div>
    `;
  });

  resultsContainer.innerHTML = html;
}

async function renderFollowingList() {
  const container = document.getElementById('friends-following-list');
  if (!container) return;

  if (followingListCache.size === 0) {
    container.innerHTML = '<div class="empty-state">You aren\'t following anyone yet. Search handles above to add friends!</div>';
    return;
  }

  const isCacheExpired = !allFirestoreUsersCache || (Date.now() - allFirestoreUsersCacheTime > USERS_CACHE_TTL_MS);
  if (isCacheExpired && window.MacromixFirebase && typeof window.MacromixFirebase.getAllFirestoreUsers === 'function') {
    allFirestoreUsersCache = await window.MacromixFirebase.getAllFirestoreUsers();
    allFirestoreUsersCacheTime = Date.now();
  }

  const usersMap = new Map();
  (allFirestoreUsersCache || []).forEach(u => usersMap.set(u.handle, u));

  let html = '';
  followingListCache.forEach(friendHandle => {
    const user = usersMap.get(friendHandle) || { handle: friendHandle, streak: 0 };
    const initial = (friendHandle[0] || 'M').toUpperCase();
    const streak = typeof user.streak === 'number' ? user.streak : 0;
    html += `
      <div class="friend-card" id="following-friend-${friendHandle}">
        <div class="friend-card-left" onclick="viewFriendProfile('${escapeHtml(friendHandle)}')">
          <div class="friend-avatar-badge">${initial}</div>
          <div class="friend-card-meta">
            <span class="friend-card-handle">${escapeHtml(friendHandle)}</span>
            <span class="friend-card-streak">🔥 ${streak}d streak</span>
          </div>
        </div>
        <div class="friend-card-actions">
          <button type="button" class="btn-friend-action btn-macromix" onclick="viewFriendProfile('${escapeHtml(friendHandle)}')">macromix</button>
          <button type="button" class="btn-friend-action btn-follow following" onclick="toggleFollowUser('${escapeHtml(friendHandle)}', this)">✓ Following</button>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

async function toggleFollowUser(targetHandle, btnEl) {
  if (!currentUserHandle) {
    alert("Please log in or claim your handle first to follow friends!");
    return;
  }
  const cleanTarget = targetHandle.trim().toLowerCase().replace(/^@+/, '');
  const currentlyFollowing = followingListCache.has(cleanTarget);

  if (currentlyFollowing) {
    followingListCache.delete(cleanTarget);
    if (btnEl) {
      btnEl.classList.remove('following');
      btnEl.textContent = '+ Follow';
    }
    if (window.MacromixFirebase && typeof window.MacromixFirebase.unfollowUser === 'function') {
      await window.MacromixFirebase.unfollowUser(currentUserHandle, cleanTarget);
    }
  } else {
    followingListCache.add(cleanTarget);
    if (btnEl) {
      btnEl.classList.add('following');
      btnEl.textContent = '✓ Following';
    }
    if (window.MacromixFirebase && typeof window.MacromixFirebase.followUser === 'function') {
      await window.MacromixFirebase.followUser(currentUserHandle, cleanTarget);
    }
  }
  renderFollowingList();
}

// ==========================================================================
// User Profile & Frictionless Onboarding Controller
// ==========================================================================

async function checkUserProfileOnboarding() {
  const onboardingEl = document.getElementById('onboarding-screen');
  const badgeEl = document.getElementById('tab-pill-me');
  const badgeText = document.getElementById('header-handle-text');

  // 1. Check cached session first for instant resume without blocking
  const cachedHandle = localStorage.getItem('macromix_user_handle');
  if (cachedHandle) {
    currentUserHandle = cachedHandle;
    if (badgeText) badgeText.textContent = 'Me';
    if (badgeEl) badgeEl.style.display = '';
    if (onboardingEl) onboardingEl.classList.add('hidden');
    document.body.style.overflow = '';
    try {
      const rawMeals = localStorage.getItem(getMealsStorageKey(cachedHandle));
      if (rawMeals) currentUserStreak = calculateStreakForLogs(JSON.parse(rawMeals));
    } catch (e) {}
    renderCurrentUserStreak();
    setupRealtimeMealsSync();
    setupCurrentUserProfileSync();
    updateHeaderFriendsBtn();
    updateWeekendWrappedVisibility();
    updateTopAnnouncementBanner();
    return;
  }

  // 2. Wait for Firebase Auth state to resolve (max 3s)
  const user = await new Promise((resolve) => {
    if (!window.__macromixAuth) {
      resolve(null);
      return;
    }
    const unsub = window.__macromixAuth.onAuthStateChanged((u) => {
      unsub();
      resolve(u);
    });
    setTimeout(() => resolve(null), 3000);
  });

  if (user && user.displayName) {
    const handle = user.displayName.replace(/^@+/, '');
    
    // We only need to fetch the profile to confirm it exists, or just use the handle
    if (window.MacromixFirebase) {
      const res = await window.MacromixFirebase.createHandleProfile(handle, 'passkey');
      if (res.success && res.profile) {
        currentUserHandle = handle;
        localStorage.setItem('macromix_user_handle', handle);
        if (badgeText) badgeText.textContent = handle.replace(/^@+/, '');
        if (badgeEl) badgeEl.style.display = '';
        if (onboardingEl) onboardingEl.classList.add('hidden');
        document.body.style.overflow = '';
        
        try {
          const rawMeals = localStorage.getItem(getMealsStorageKey(handle));
          if (rawMeals) {
            currentUserStreak = calculateStreakForLogs(JSON.parse(rawMeals));
          }
        } catch (e) {}
        renderCurrentUserStreak();
        
        setupRealtimeMealsSync();
        setupCurrentUserProfileSync();
        updateHeaderFriendsBtn();
        updateWeekendWrappedVisibility();
        updateTopAnnouncementBanner();
        return;
      }
    }
  }

  // 3. User is unauthenticated: they MUST register/create an account first before seeing the shared profile!
  const routeHandle = parseUrlHandle();
  if (routeHandle) {
    sessionStorage.setItem('macromix_pending_share_handle', routeHandle);
    showSharedInviteNotice(routeHandle);
  }

  if (onboardingEl) {
    onboardingEl.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }
}

function showSharedInviteNotice(friendHandle) {
  const introHeadline = document.getElementById('onboarding-title');
  if (introHeadline && friendHandle) {
    introHeadline.innerHTML = `👋 <strong>@${escapeHtml(friendHandle)}</strong> shared their macros!<br><span style="font-size: 0.95rem; font-weight: 700; color: #121212;">Create your handle or sign in to view their profile.</span>`;
  }
}

function showOnboardingError(msg) {
  const statusEl = document.getElementById('handle-status-msg');
  if (statusEl) {
    statusEl.textContent = msg;
    statusEl.className = 'handle-status-msg error';
  }
}

function clearOnboardingError() {
  const statusEl = document.getElementById('handle-status-msg');
  if (statusEl) {
    statusEl.textContent = '';
    statusEl.className = 'handle-status-msg';
  }
}

async function registerHandleOnboarding(handle, authMethod = 'passkey') {
  clearOnboardingError();
  const clean = (handle || '').trim().toLowerCase().replace(/^@+/, '');
  if (!clean || clean.length < 3 || clean.length > 12 || !/^[a-z0-9_]+$/.test(clean)) {
    showOnboardingError("Handle must be 3-12 characters (letters, numbers, underscores).");
    return false;
  }

  // 1. Direct Client Firestore Registration / Seamless Login
  let fireRes = null;
  if (window.MacromixFirebase && typeof window.MacromixFirebase.createHandleProfile === 'function') {
    try {
      fireRes = await window.MacromixFirebase.createHandleProfile(clean, authMethod, userTargets);
      if (!fireRes.success) {
        showOnboardingError(fireRes.error || "Could not claim handle. Please try another.");
        return false;
      }
      // If logging into an existing account, restore cloud targets & streak
      if (fireRes.isLogin && fireRes.profile) {
        if (fireRes.profile.dailyTargets) {
          userTargets = fireRes.profile.dailyTargets;
          localStorage.setItem('macronomics_targets', JSON.stringify(userTargets));
          applyTargetsToUI();
        }
        if (typeof fireRes.profile.streak === 'number') {
          const streakBadge = document.getElementById('streak-badge');
          if (streakBadge) {
            streakBadge.textContent = `🔥 ${fireRes.profile.streak}d`;
          }
        }
      }
    } catch (fErr) {
      console.warn("[Macromix] Firestore handle registration warning:", fErr);
    }
  }

  // 2. Also persist to local FastAPI server if running locally
  if (isLocalBackend()) {
    try {
      const res = await fetch('/api/user/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle: clean, user_id: 1 })
      });

      if (!res.ok) {
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
          const err = await res.json();
          if (res.status === 409 && !fireRes?.isLogin) {
            showOnboardingError(err.detail || "Could not claim handle. Please try another.");
            return false;
          }
        }
      }
    } catch (e) {
      // Local server offline; client Firestore handles persistence
    }
  }

  currentUserHandle = clean;
  localStorage.setItem('macromix_user_handle', clean);

  const pillMe = document.getElementById('tab-pill-me');
  const badgeText = document.getElementById('header-handle-text');
  if (badgeText) badgeText.textContent = 'Me';
  if (pillMe) pillMe.style.display = '';

  const onboardingEl = document.getElementById('onboarding-screen');
  if (onboardingEl) {
    onboardingEl.classList.add('hidden');
  }
  document.body.style.overflow = '';

  const actionType = fireRes?.isLogin ? 'Logged in' : 'Successfully onboarded';
  AppLogger.log('AUTH', `${actionType} user via ${authMethod}: @${clean}`, { handle: clean, authMethod, isLogin: fireRes?.isLogin }, 'SUCCESS');

  setupRealtimeMealsSync();
  setupCurrentUserProfileSync();
  setupRealtimeProfileSync();
  await loadMealLogs();
  currentUserStreak = calculateStreak();
  updateHeaderFriendsBtn();
  updateWeekendWrappedVisibility();
  updateTopAnnouncementBanner();
  triggerEmptyStateCardJiggle();

  // If the user arrived via a friend's profile link, navigate to that profile now that they are authenticated!
  const pendingShareHandle = sessionStorage.getItem('macromix_pending_share_handle') || parseUrlHandle();
  if (pendingShareHandle && pendingShareHandle.toLowerCase() !== clean.toLowerCase()) {
    sessionStorage.removeItem('macromix_pending_share_handle');
    await viewFriendProfile(pendingShareHandle);
  }
  return true;
}

// ─── Cloud Function base URL ───────────────────────────────────
const AUTH_BASE = ''; // Uses relative paths with Firebase Hosting rewrites

// ─── @simplewebauthn/browser (loaded locally or from bundle) ───
let _swab = null;
async function getSimpleWebAuthn() {
  if (window.SimpleWebAuthnBrowser) {
    return window.SimpleWebAuthnBrowser;
  }
  if (!_swab) {
    try {
      _swab = await import('./simplewebauthn-browser.min.js');
    } catch (e) {
      _swab = await import(
        'https://cdn.jsdelivr.net/npm/@simplewebauthn/browser@10/esm/index.js'
      );
    }
  }
  return _swab;
}

// ─── Device Tip ─────────────────────────────────────────────
function showDeviceTip() {
  const ua = navigator.userAgent;
  if (/Macintosh|Windows/.test(ua)) {
    const tip = document.getElementById('passkey-device-tip');
    if (tip) tip.classList.remove('hidden');
  }
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

  let isExisting = false;
  if (isLocalBackend()) {
    try {
      const chkRes = await fetch(`/api/handle/check/${encodeURIComponent(clean)}`);
      if (chkRes.ok) {
        const chkData = await chkRes.json();
        isExisting = !chkData.available;
      }
    } catch (e) {}
  } else if (window.MacromixFirebase && typeof window.MacromixFirebase.checkHandleAvailable === 'function') {
    try {
      const isAvailable = await window.MacromixFirebase.checkHandleAvailable(clean);
      isExisting = !isAvailable;
    } catch (e) {}
  }

  if (isExisting) {
    await passkeyLogin(clean);
  } else {
    await passkeyRegister(clean);
  }
}

async function registerHandleNativePasskey(clean) {
  if (window.PublicKeyCredential) {
    try {
      const challenge = new Uint8Array(32);
      window.crypto.getRandomValues(challenge);
      const userIdBytes = new Uint8Array(16);
      window.crypto.getRandomValues(userIdBytes);

      const credential = await navigator.credentials.create({
        publicKey: {
          challenge: challenge,
          rp: { name: "macromix", id: window.location.hostname },
          user: {
            id: userIdBytes,
            name: clean,
            displayName: "@" + clean
          },
          pubKeyCredParams: [
            { alg: -7, type: "public-key" },
            { alg: -257, type: "public-key" }
          ],
          authenticatorSelection: {
            authenticatorAttachment: "platform",
            userVerification: "preferred"
          },
          timeout: 60000
        }
      });
      if (credential) {
        AppLogger.log('AUTH', 'WebAuthn passkey credential created successfully');
      }
    } catch (err) {
      AppLogger.log('AUTH', 'WebAuthn prompt completed/bypassed: ' + (err.message || err), null, 'INFO');
    }
  }
  await registerHandleOnboarding(clean, 'passkey');
}

// ─── Registration (TOFU) ─────────────────────────────────────────────
async function passkeyRegister(handle) {
  let options;
  try {
    const res = await fetch(`${AUTH_BASE}/authRegisterBegin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle }),
    });
    const ct = res.headers.get('content-type') || '';
    if (!res.ok || !ct.includes('application/json')) {
      if (!isLocalBackend()) {
        await registerHandleNativePasskey(handle);
        return;
      }
      const err = await res.json().catch(() => ({}));
      showOnboardingError(err.detail || err.error || 'Could not start registration.');
      return;
    }
    options = await res.json();
  } catch (e) {
    if (!isLocalBackend()) {
      await registerHandleNativePasskey(handle);
      return;
    }
    showOnboardingError('Network error. Please try again.');
    return;
  }

  let attestation;
  try {
    const { startRegistration } = await getSimpleWebAuthn();
    attestation = await startRegistration({ optionsJSON: options });
  } catch (e) {
    AppLogger.log('AUTH', 'Registration cancelled/unsupported: ' + e.message, null, 'INFO');
    showOnboardingError('Passkey setup was cancelled. Please try again.');
    return;
  }

  let customToken;
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
    const data = await res.json();
    customToken = data.customToken;
  } catch (e) {
    showOnboardingError('Server error during registration. Please try again.');
    return;
  }

  if (customToken && !customToken.startsWith('local_token_')) {
    try {
      if (window.MacromixFirebase && typeof window.MacromixFirebase.completeCustomTokenAuth === 'function') {
        await window.MacromixFirebase.completeCustomTokenAuth(customToken);
      }
    } catch (e) {
      showOnboardingError('Could not complete sign-in. Please try again.');
      return;
    }
  }

  AppLogger.log('AUTH', `Passkey registered for @${handle}`, { handle }, 'SUCCESS');
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
    const ct = res.headers.get('content-type') || '';
    if (!res.ok || !ct.includes('application/json')) {
      const err = await res.json().catch(() => ({}));
      const msg = err.detail || err.error || '';
      if (res.status === 404 || msg.toLowerCase().includes('register')) {
        AppLogger.log('AUTH', `Handle @${handle} has no passkey on record, switching to registration...`, null, 'INFO');
        await passkeyRegister(handle);
        return;
      }
      showOnboardingError(msg || 'Could not start login.');
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

  let customToken;
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
    const data = await res.json();
    customToken = data.customToken;
  } catch (e) {
    showOnboardingError('Server error during login. Please try again.');
    return;
  }

  if (customToken && !customToken.startsWith('local_token_')) {
    try {
      if (window.MacromixFirebase && typeof window.MacromixFirebase.completeCustomTokenAuth === 'function') {
        await window.MacromixFirebase.completeCustomTokenAuth(customToken);
      }
    } catch (e) {
      showOnboardingError('Could not complete sign-in. Please try again.');
      return;
    }
  }

  AppLogger.log('AUTH', `Passkey login for @${handle}`, { handle }, 'SUCCESS');
  await registerHandleOnboarding(handle, 'passkey');
}

// ─── Google OIDC Authentication Flow ─────────────────────────
async function handleGoogleAuth() {
  clearOnboardingError();
  AppLogger.log('AUTH', 'Starting Google Sign-In flow');
  try {
    await waitForFirebaseDB();
    if (!window.MacromixFirebase || typeof window.MacromixFirebase.signInWithGoogle !== 'function') {
      showOnboardingError('Google Sign-In is initializing. Please retry in a moment.');
      return;
    }
    const res = await window.MacromixFirebase.signInWithGoogle();
    if (!res.success) {
      if (res.redirecting) return;
      showOnboardingError(res.error || 'Google Sign-In failed.');
      return;
    }
    const googleUser = res.user;
    const existingProfile = await window.MacromixFirebase.findUserByGoogleAuth(googleUser.uid, googleUser.email);
    if (existingProfile && existingProfile.handle) {
      await registerHandleOnboarding(existingProfile.handle, 'google', existingProfile);
      return;
    }
    let defaultHandle = (googleUser.email ? googleUser.email.split('@')[0] : (googleUser.displayName || 'user'))
      .toLowerCase().replace(/[^a-z0-9_]/g, '').substring(0, 12);
    if (defaultHandle.length < 3) defaultHandle = 'user_' + googleUser.uid.substring(0, 6);

    const userHandle = prompt('Welcome to macromix! Choose your handle (3-12 characters, lowercase letters & numbers):', defaultHandle);
    if (!userHandle || !userHandle.trim()) {
      showOnboardingError('Handle is required to complete profile setup.');
      return;
    }
    const cleanHandle = userHandle.trim().toLowerCase().replace(/^@+/, '');
    const createRes = await window.MacromixFirebase.createHandleProfile(cleanHandle, 'google', userTargets, googleUser);
    if (!createRes.success) {
      showOnboardingError(createRes.error || 'Failed to claim handle.');
      return;
    }
    await registerHandleOnboarding(cleanHandle, 'google', createRes.profile);
  } catch (err) {
    AppLogger.log('AUTH', 'Google Sign-In error: ' + err.message, null, 'ERROR');
    showOnboardingError('Google Sign-In error: ' + err.message);
  }
}

// ─── Unified Elevated Top Announcement Banner Manager ─────────────
const BANNER_SNOOZE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days snooze

let deferredInstallPrompt = null;
let currentActiveBannerId = null;

function isPwaInstalled() {
  return (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
         (typeof navigator !== 'undefined' && navigator.standalone === true) ||
         localStorage.getItem('macromix_pwa_installed') === 'true';
}

function isBannerSnoozed(bannerId) {
  const snoozedUntil = localStorage.getItem(`macromix_banner_snooze_${bannerId}`);
  if (!snoozedUntil) return false;
  return Date.now() < parseInt(snoozedUntil, 10);
}

function snoozeBanner(bannerId) {
  const until = Date.now() + BANNER_SNOOZE_MS;
  localStorage.setItem(`macromix_banner_snooze_${bannerId}`, until.toString());
}

const FEATURE_BANNERS = [
  // Smart banners (notifications opt-in & pwa install) removed per user request
];

function updateTopAnnouncementBanner() {
  const container = document.getElementById('top-announcement-banner') || document.getElementById('pwa-install-banner');
  if (container) {
    container.classList.remove('visible');
    container.setAttribute('aria-hidden', 'true');
    container.style.display = 'none';
  }
  currentActiveBannerId = null;
}

function dismissActiveAnnouncementBanner() {
  if (currentActiveBannerId) {
    snoozeBanner(currentActiveBannerId);
  }
  const container = document.getElementById('top-announcement-banner') || document.getElementById('pwa-install-banner');
  if (container) {
    container.classList.remove('visible');
    container.setAttribute('aria-hidden', 'true');
  }
  currentActiveBannerId = null;
}

function handleActiveAnnouncementCta() {
  const banner = FEATURE_BANNERS.find(b => b.id === currentActiveBannerId);
  if (banner && typeof banner.onAction === 'function') {
    banner.onAction();
  }
}

function checkAndTriggerInstallBanner() {
  updateTopAnnouncementBanner();
}

function dismissInstallBanner() {
  dismissActiveAnnouncementBanner();
}

async function handlePwaInstallAction() {
  if (deferredInstallPrompt) {
    try {
      deferredInstallPrompt.prompt();
      const { outcome } = await deferredInstallPrompt.userChoice;
      if (outcome === 'accepted') {
        localStorage.setItem('macromix_pwa_installed', 'true');
        updateTopAnnouncementBanner();
      }
    } catch (e) {
      console.warn('[PWA] Prompt error:', e);
    }
    deferredInstallPrompt = null;
  } else {
    // Check if iOS Safari / WebKit
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (isIos) {
      openIosInstallModal();
    } else {
      alert('To install macromix:\nClick the Install icon in your browser address bar or menu.');
    }
  }
}

function openIosInstallModal() {
  const modal = document.getElementById('ios-install-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeIosInstallModal() {
  const modal = document.getElementById('ios-install-modal');
  if (modal) modal.classList.add('hidden');
}

// ==========================================================================
// Weekend Wrapped Feature Controller (Exclusively for @istashmacros and @kalay on Friday/Weekend)
// ==========================================================================
const WRAPPED_SLIDE_DURATION_MS = 6500;
const WRAPPED_CURRENT_EDITION = '2026_w45_nov';
let wrappedCurrentSlide = 0;
let wrappedSlideTimer = null;
let wrappedStartTime = 0;
let wrappedElapsed = 0;
let wrappedIsPaused = false;
let wrappedSoundEnabled = true;
let wrappedAudioCtx = null;
let _wrappedEventsInitialized = false;
let _wrappedSlideViewedCount = 0;
let _wrappedOpenTime = 0;

function hasUserViewedWeekendWrapped(handle) {
  const clean = (handle || getWrappedActiveHandle() || '').trim().toLowerCase().replace(/^@+/, '');
  if (!clean) return false;
  if (typeof localStorage !== 'undefined') {
    if (localStorage.getItem(`macromix_wrapped_viewed_${clean}_${WRAPPED_CURRENT_EDITION}`) === '1' ||
        localStorage.getItem(`macromix_wrapped_viewed_${clean}`) === '1') {
      return true;
    }
  }
  return false;
}

function markWeekendWrappedViewed(handle) {
  const clean = (handle || getWrappedActiveHandle() || '').trim().toLowerCase().replace(/^@+/, '');
  if (!clean) return;

  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(`macromix_wrapped_viewed_${clean}`, '1');
    localStorage.setItem(`macromix_wrapped_viewed_${clean}_${WRAPPED_CURRENT_EDITION}`, '1');
  }

  if (window.MacromixFirebase && typeof window.MacromixFirebase.syncWeekendWrappedViewedToFirestore === 'function') {
    window.MacromixFirebase.syncWeekendWrappedViewedToFirestore(clean, WRAPPED_CURRENT_EDITION);
  }
}

const WRAPPED_PROFILES = {
  istashmacros: {
    avatar: '🥣',
    handle: '@istashmacros',
    fridayTag: 'FRIDAY WRAPPED',
    shareText: "🥣 @istashmacros's Weekend Review Wrapped:\n" +
               "🔥 10-day streak unbroken!\n" +
               "💪 869.2g Protein banked (29 chicken breasts equivalent)\n" +
               "🧬 Persona: The Skyr & Sambar Alchemist\n" +
               "Tracked on macromix.web.app",
    slide1: {
      subtitle: 'You logged consistently and kept your nutrition fire burning strong.',
      totalCalories: '15,198',
      badge: '40 MEALS',
      totalProtein: '869.2',
      proteinEquiv: 'Equivalent to <strong>29 chicken breasts</strong> or <strong>145 whole eggs</strong>!',
      streak: '10-DAY STREAK',
      streakSubtitle: 'Unbroken momentum alive!'
    },
    slide2: {
      title: 'The Dosa & Skyr<br><span style="background: #111; color: #FFE600; padding: 2px 8px; border-radius: 8px;">Power Combo</span>',
      subtitle: 'When hunger struck, you had your signature breakfast playbook locked in.',
      topItems: [
        { name: '🍌 Bananas', badge: '7 Times', bg: '#FFE600' },
        { name: '🥞 Crispy Dosa', badge: '5 Times', bg: '#fed7aa' },
        { name: '🥣 Rolled Oats & Walnuts', badge: '5 Times', bg: '#e2e8f0' },
        { name: '☕ Filter Coffee with Milk', badge: '3 Times', bg: '#dbeafe' }
      ],
      quote: 'I started off by having four dosas, rolled oats with walnuts and yeast protein... then 200g of Skyr.',
      peakLabel: 'Peak Fuel Window',
      peakTime: '08:00 – 10:00 AM'
    },
    slide3: {
      dayTitle: 'Wednesday, Oct 30',
      subtitle: 'When you fired on all cylinders, your macros aligned with laser precision.',
      peakProtein: '156.9',
      pctGoal: '+112% OF GOAL',
      targetProtein: '140g',
      scorecard1: { label: 'Fat Target (65g)', value: '68.2g Avg (95% Precision)', pct: 95 },
      scorecard2: { label: 'Protein Target (140g)', value: '124.2g Avg (89% Compliance)', pct: 89 },
      winTitle: 'Consistency Win',
      winBody: 'You hit <strong>30g+ of fiber</strong> on 4 separate days (Oct 29, 30, 31, and Nov 02)!'
    },
    slide4: {
      title: 'The Missing<br><span style="background: #FFE600; color: #111; padding: 2px 8px; border-radius: 8px;">13.5g of Fiber</span>',
      subtitle: 'Your fiber averaged <strong>24.5g</strong> vs your <strong>38g</strong> target. No boring salads — here is how to bridge it with foods you already love:',
      swap1: {
        badge: 'SWAP 1 • MORNING',
        gain: '+9g FIBER',
        name: 'Stir 2 tbsp Chia Seeds into your Skyr & Rolled Oats',
        desc: 'You already logged chia seeds on Oct 30! Making it a daily morning staple adds <strong>9g prebiotic fiber</strong> effortlessly.'
      },
      swap2: {
        badge: 'SWAP 2 • EVENING',
        gain: '+8g FIBER & +12g P',
        name: '1 Bowl of Spiced Chana Sundal or Sprouted Moong',
        desc: 'Pairs naturally with your 5 PM milk coffee. Bridges your fiber gap while keeping calories tight.'
      }
    },
    slide5: {
      title: 'Under-Eating<br><span style="background: #fff; color: #FF3366; padding: 2px 8px; border-radius: 8px;">Deficit Detected</span>',
      subtitle: 'Most people over-eat; you actually <strong>under-consumed</strong> by ~529 kcal/day compared to your 2700 kcal goal.',
      badge: '-529 KCAL DEFICIT',
      avgKcal: '2,171',
      targetDetail: 'Target: <strong>2,700 kcal</strong> &bull; Lowest day: <strong>1,654 kcal</strong> (Nov 03).',
      prescriptionHtml: '&bull; <strong>Don\'t restrict before social dinners:</strong> Your week ran at an ~3,700 kcal cumulative deficit. You have plenty of calorie runway.<br>&bull; <strong>Add a late afternoon shake:</strong> A quick protein smoothie with milk + 1 banana prevents evening fatigue.'
    },
    slide6: {
      title: 'The Skyr & Sambar<br><span style="background: #111; color: #00F0FF; padding: 2px 8px; border-radius: 8px;">Alchemist</span>',
      subtitle: 'You sit in the top 1% of users who bridge traditional South Indian comfort with Scandinavian high-protein biohacking.',
      emoji: '🥣⚡🍌',
      archetypeName: 'The Alchemist Archetype',
      quote: 'Dosas for the soul, Skyr &amp; Yeast Protein for the gains.',
      tags: [
        { text: '🥞 Dosa Loyalist', bg: '#fef08a' },
        { text: '🇮🇸 Skyr Devotee', bg: '#bae6fd' },
        { text: '☕ Coffee Fueled', bg: '#bbf7d0' },
        { text: '🔥 10d Streaker', bg: '#fbcfe8' }
      ],
      tier: 'Silver Spark Member'
    },
    slide7: {
      handle: '@istashmacros',
      personaUpper: 'THE SKYR & SAMBAR ALCHEMIST',
      stat1Val: '15,198',
      stat1Label: 'Calories',
      stat2Val: '869.2g',
      stat2Label: 'Protein',
      stat3Val: '🔥 10d',
      stat3Label: 'Streak',
      stat4Val: '40 Meals',
      stat4Label: 'Logged'
    }
  },
  kalay: {
    avatar: '☕',
    handle: '@kalay',
    fridayTag: 'FRIDAY WRAPPED',
    shareText: "☕ @kalay's Weekend Review Wrapped:\n" +
               "🔥 4-day streak rolling!\n" +
               "💪 761.2g Protein banked (25 chicken breasts equivalent)\n" +
               "🌾 188.3g Fiber (Beat daily goal at 105%!)\n" +
               "🧬 Persona: The Filter Coffee & Dosa Titan\n" +
               "Tracked on macromix.web.app",
    slide1: {
      subtitle: 'You brought serious appetite and kept your nutrition engine firing on high octane!',
      totalCalories: '19,366',
      badge: '6 DAYS LOGGED',
      totalProtein: '761.2',
      proteinEquiv: 'Equivalent to <strong>25 whole chicken breasts</strong> or <strong>127 whole eggs</strong>!',
      streak: '4-DAY STREAK',
      streakSubtitle: 'Momentum rolling strong!'
    },
    slide2: {
      title: 'Filter Coffee &<br><span style="background: #111; color: #FFE600; padding: 2px 8px; border-radius: 8px;">Dosa Masterclass</span>',
      subtitle: 'When hunger called, your traditional breakfast and evening cafe ritual answered every single time.',
      topItems: [
        { name: '☕ Filter Coffee', badge: '7 Times', bg: '#FFE600' },
        { name: '🥞 Plain & Egg Dosa', badge: '12 Times', bg: '#fed7aa' },
        { name: '🍰 Vanilla Cake & Sweets', badge: '4 Times', bg: '#fbcfe8' },
        { name: '🥚 Hard Boiled Eggs', badge: '3 Times', bg: '#dbeafe' }
      ],
      quote: 'Started off with hot filter coffee, 3 idlis, brinjal drumstick therakkal, boiled egg, then rice with fried lady fish...',
      peakLabel: 'Peak Fuel Ritual',
      peakTime: '08:30 AM & 05:00 PM Kaapi'
    },
    slide3: {
      dayTitle: 'Monday, Nov 02',
      subtitle: 'When you fired on all cylinders, your protein surge reached towering heights.',
      peakProtein: '178.2',
      pctGoal: '+119% OF GOAL',
      targetProtein: '150g',
      scorecard1: { label: 'Fiber Target (30g)', value: '31.4g Avg (105% Precision)', pct: 100 },
      scorecard2: { label: 'Protein Target (150g)', value: '126.9g Avg (85% Compliance)', pct: 85 },
      winTitle: 'Fiber Champion',
      winBody: 'You smashed your fiber goal, logging up to <strong>43g of fiber</strong> in a single day thanks to chana, dal, and poriyals!'
    },
    slide4: {
      title: 'The Sweet Tooth<br><span style="background: #FFE600; color: #111; padding: 2px 8px; border-radius: 8px;">Macro Pivot</span>',
      subtitle: 'Your fiber is dialed at 105%. Here is how to keep calories tight while honoring foods you love:',
      swap1: {
        badge: 'SWAP 1 • EVENING',
        gain: 'SAVE 240 KCAL & +10g P',
        name: 'Trade Vanilla Cake & Murukku for Warm Chana Sundal',
        desc: 'Cuts 18g of excess fat while complementing your 5 PM filter coffee with fiber and clean plant protein.'
      },
      swap2: {
        badge: 'SWAP 2 • BREAKFAST',
        gain: '+14g PROTEIN',
        name: 'Swap 2 Plain Dosas for Pesarattu (Moong Dal Dosa) or Adai',
        desc: 'Keeps the exact same crispy warmth and chutney experience, while doubling your protein absorption.'
      }
    },
    slide5: {
      title: 'High Energy<br><span style="background: #fff; color: #FF3366; padding: 2px 8px; border-radius: 8px;">Surplus Detected</span>',
      subtitle: 'You averaged <strong>3,228 kcal/day</strong> against your 2,000 kcal target — running at an energy surplus of +1,228 kcal/day.',
      badge: '+1,228 KCAL SURPLUS',
      avgKcal: '3,228',
      targetDetail: 'Target: <strong>2,000 kcal</strong> &bull; Carbs: <strong>404g avg</strong> &bull; Fat: <strong>122.8g avg</strong>.',
      prescriptionHtml: '&bull; <strong>Tawa Grill vs Deep Fry:</strong> Switch from deep-fried fish to tawa grilled meen to trim 250 kcal of cooking oil instantly.<br>&bull; <strong>Post-Meal 15-min Stroll:</strong> A gentle walk after heavy dosa lunches channels high carbohydrate intake directly into muscle glycogen.'
    },
    slide6: {
      title: 'The Filter Coffee &<br><span style="background: #111; color: #00F0FF; padding: 2px 8px; border-radius: 8px;">Dosa Titan</span>',
      subtitle: 'You honor authentic South Indian cuisine with unapologetic passion, massive caloric fire, and rich traditional flavor.',
      emoji: '☕🥞🐟🔥',
      archetypeName: 'The Dosa Titan Archetype',
      quote: 'Dosas by the plate, piping hot kaapi, and feasts built for champions.',
      tags: [
        { text: '🥞 Dosa Titan', bg: '#fef08a' },
        { text: '☕ Kaapi Devotee', bg: '#bae6fd' },
        { text: '🐟 Meen Kuzhambu Fan', bg: '#bbf7d0' },
        { text: '🔥 4d Streaker', bg: '#fbcfe8' }
      ],
      tier: 'Gold Feast Member'
    },
    slide7: {
      handle: '@kalay',
      personaUpper: 'THE FILTER COFFEE & DOSA TITAN',
      stat1Val: '19,366',
      stat1Label: 'Calories',
      stat2Val: '761.2g',
      stat2Label: 'Protein',
      stat3Val: '🔥 4d',
      stat3Label: 'Streak',
      stat4Val: '188g',
      stat4Label: 'Fiber (105%)'
    }
  }
};

function getWrappedActiveHandle() {
  const handle = (currentUserHandle || (typeof localStorage !== 'undefined' ? localStorage.getItem('macromix_user_handle') : '') || '').trim().toLowerCase().replace(/^@+/, '');
  if (WRAPPED_PROFILES[handle]) return handle;
  return 'istashmacros';
}

function isWeekendWrappedEligible() {
  const handle = (currentUserHandle || (typeof localStorage !== 'undefined' ? localStorage.getItem('macromix_user_handle') : '') || '').trim().toLowerCase().replace(/^@+/, '');
  if (handle !== 'istashmacros' && handle !== 'kalay') return false;

  // Check URL query param ?wrapped=1 or ?wrapped=true
  if (typeof window !== 'undefined' && window.location) {
    const params = new URLSearchParams(window.location.search);
    if (params.get('wrapped') === '1' || params.get('wrapped') === 'true') {
      return true;
    }
  }

  // Keep it available until the user has accessed it and viewed it at least once
  const hasViewed = hasUserViewedWeekendWrapped(handle);
  if (!hasViewed) {
    return true;
  }

  // Once viewed at least once, the glowing ring is dismissed on weekdays and regular days
  return false;
}

function renderWeeklyWrappedSlides(handle) {
  const normalized = (handle || getWrappedActiveHandle() || '').trim().toLowerCase().replace(/^@+/, '');
  const profile = WRAPPED_PROFILES[normalized] || WRAPPED_PROFILES['istashmacros'];

  const avatarEl = document.getElementById('wrappedUserAvatar');
  if (avatarEl) avatarEl.textContent = profile.avatar;

  const handleEl = document.getElementById('wrappedUserHandle');
  if (handleEl) handleEl.textContent = profile.handle;

  const deck = document.getElementById('wrappedSlidesDeck');
  if (!deck) return;

  const s1 = profile.slide1;
  const s2 = profile.slide2;
  const s3 = profile.slide3;
  const s4 = profile.slide4;
  const s5 = profile.slide5;
  const s6 = profile.slide6;
  const s7 = profile.slide7;

  const topItemsHtml = s2.topItems.map((item, idx) => {
    const borderStyle = idx < s2.topItems.length - 1 ? 'border-bottom: 2px dashed #e2e8f0; padding-bottom: 4px;' : '';
    return `<div style="display: flex; justify-content: space-between; align-items: center; ${borderStyle}">
      <span style="font-weight: 800; font-size: 13px;">${item.name}</span>
      <span class="wrapped-brutal-badge" style="background: ${item.bg}; padding: 2px 8px; font-size: 10px;">${item.badge}</span>
    </div>`;
  }).join('');

  const tagsHtml = s6.tags.map(t =>
    `<span class="wrapped-brutal-badge" style="background: ${t.bg}; font-size: 9px;">${t.text}</span>`
  ).join('');

  deck.innerHTML = `
    <!-- SLIDE 1: The Overture / Scale -->
    <div class="wrapped-slide wrapped-slide-1 active" data-slide="0">
      <div style="position: relative;">
        <div class="wrapped-brutal-badge" style="background: #111; color: #FFE600;">
          ⚡ 7-DAY NUTRITION REEL
        </div>
        <h1 class="wrapped-font-grotesk" style="font-size: 34px; line-height: 1.02; font-weight: 900; margin-top: 12px; text-transform: uppercase; letter-spacing: -1.5px; color: #111;">
          Your Week<br><span style="background: #111; color: #fff; padding: 2px 8px; border-radius: 8px;">In Fuel</span>
        </h1>
        <p style="font-size: 13px; font-weight: 700; margin-top: 8px; color: #222;">
          ${s1.subtitle}
        </p>
      </div>

      <div style="display: flex; flex-direction: column; gap: 10px;">
        <div class="wrapped-brutal-card" style="background: #fff; transform: rotate(-1deg);">
          <div style="display: flex; justify-content: space-between; align-items: flex-end;">
            <div>
              <div class="wrapped-stat-hero-number" id="wrapped-stat-cal" style="color: #FF3366;">${s1.totalCalories}</div>
              <div class="wrapped-sub-hero-label" style="color: #64748b;">Total Calories Logged</div>
            </div>
            <div class="wrapped-brutal-badge" id="wrapped-stat-meals" style="background: #FFE600; font-size: 11px;">${s1.badge}</div>
          </div>
        </div>

        <div class="wrapped-brutal-card" style="background: #fff; transform: rotate(1.5deg);">
          <div style="display: flex; justify-content: space-between; align-items: flex-end;">
            <div>
              <div class="wrapped-stat-hero-number" id="wrapped-stat-protein" style="color: #111;">${s1.totalProtein}<span style="font-size: 24px;">g</span></div>
              <div class="wrapped-sub-hero-label" style="color: #64748b;">Total Protein Banked</div>
            </div>
            <div style="font-size: 28px;">🍗</div>
          </div>
          <p style="font-size: 12px; font-weight: 700; color: #475569; margin-top: 6px;">
            ${s1.proteinEquiv}
          </p>
        </div>

        <div class="wrapped-brutal-card" style="background: #111; color: #fff; display: flex; align-items: center; justify-content: space-between; padding: 12px 16px;">
          <div style="display: flex; align-items: center; gap: 10px;">
            <span style="font-size: 28px;">🔥</span>
            <div>
              <div style="font-size: 16px; font-weight: 900; color: #FFE600;" id="wrapped-stat-streak">${s1.streak}</div>
              <div style="font-size: 11px; color: #94a3b8; font-weight: 700;">${s1.streakSubtitle}</div>
            </div>
          </div>
          <div class="wrapped-brutal-badge" style="background: #00F59B; color: #111;">ACTIVE</div>
        </div>
      </div>

      <div style="text-align: center; font-size: 12px; font-weight: 800; color: rgba(0,0,0,0.6);">
        TAP ANYWHERE TO CONTINUE &rarr;
      </div>
    </div>

    <!-- SLIDE 2: The MVP Meal & Habit -->
    <div class="wrapped-slide wrapped-slide-2" data-slide="1">
      <div>
        <div class="wrapped-brutal-badge" style="background: #FFE600; color: #111;">
          👑 YOUR #1 COMFORT WEAPON
        </div>
        <h2 class="wrapped-font-grotesk" style="font-size: 32px; line-height: 1.05; font-weight: 900; margin-top: 12px; letter-spacing: -1px; text-transform: uppercase;">
          ${s2.title}
        </h2>
        <p style="font-size: 13px; font-weight: 600; margin-top: 6px; color: #ffe4e6;">
          ${s2.subtitle}
        </p>
      </div>

      <div style="display: flex; flex-direction: column; gap: 10px;">
        <div class="wrapped-brutal-card" style="background: #fff; color: #111;">
          <div style="font-size: 11px; font-weight: 900; color: #e11d48; text-transform: uppercase;">
            Top Logged Fuel Items
          </div>
          <div style="margin-top: 8px; display: flex; flex-direction: column; gap: 6px;">
            ${topItemsHtml}
          </div>
        </div>

        <div class="wrapped-brutal-card" style="background: #111; color: #fff; border-color: #FFE600;">
          <div style="font-size: 10px; font-weight: 800; color: #FFE600; text-transform: uppercase;">
            🎙️ From Your Real Audio Logs:
          </div>
          <p style="font-size: 12px; font-style: italic; font-weight: 600; margin-top: 4px; color: #f8fafc; line-height: 1.35;">
            &ldquo;${s2.quote}&rdquo;
          </p>
        </div>

        <div class="wrapped-brutal-badge" style="background: #fff; color: #111; align-self: flex-start; font-size: 11px;">
          ⏰ ${s2.peakLabel}: <strong>${s2.peakTime}</strong>
        </div>
      </div>

      <div style="text-align: center; font-size: 12px; font-weight: 800; color: rgba(255,255,255,0.7);">
        TAP TO VIEW HIGHLIGHTS &rarr;
      </div>
    </div>

    <!-- SLIDE 3: Consistency High Note -->
    <div class="wrapped-slide wrapped-slide-3" data-slide="2">
      <div>
        <div class="wrapped-brutal-badge" style="background: #111; color: #00F59B;">
          🏆 THE MASTERCLASS DAY
        </div>
        <h2 class="wrapped-font-grotesk" style="font-size: 32px; line-height: 1.05; font-weight: 900; margin-top: 12px; letter-spacing: -1px; text-transform: uppercase;">
          ${s3.dayTitle}<br><span style="background: #111; color: #fff; padding: 2px 8px; border-radius: 8px;">Peak Output</span>
        </h2>
        <p style="font-size: 13px; font-weight: 700; margin-top: 6px; color: #064e3b;">
          ${s3.subtitle}
        </p>
      </div>

      <div style="display: flex; flex-direction: column; gap: 10px;">
        <div class="wrapped-brutal-card" style="background: #fff;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div>
              <div style="font-size: 11px; font-weight: 800; color: #64748b;">RECORD PROTEIN HIT</div>
              <div class="wrapped-stat-hero-number" style="color: #059669; font-size: 38px;">${s3.peakProtein}<span style="font-size: 20px;">g</span></div>
            </div>
            <div style="text-align: right;">
              <div style="font-size: 10px; font-weight: 900; background: #d1fae5; color: #065f46; padding: 3px 8px; border-radius: 999px; border: 1.5px solid #059669;">
                ${s3.pctGoal}
              </div>
              <div style="font-size: 11px; font-weight: 800; color: #475569; margin-top: 4px;">Target: ${s3.targetProtein}</div>
            </div>
          </div>
        </div>

        <div class="wrapped-brutal-card" style="background: #fff;">
          <div style="font-size: 11px; font-weight: 900; color: #475569; text-transform: uppercase; margin-bottom: 6px;">
            7-Day Macro Accuracy Scorecard
          </div>
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <div>
              <div style="display: flex; justify-content: space-between; font-size: 12px; font-weight: 800;">
                <span>${s3.scorecard1.label}</span>
                <span style="color: #059669;">${s3.scorecard1.value}</span>
              </div>
              <div style="width: 100%; height: 6px; background: #e2e8f0; border-radius: 999px; overflow: hidden; margin-top: 3px;">
                <div style="width: ${s3.scorecard1.pct}%; height: 100%; background: #059669;"></div>
              </div>
            </div>
            <div>
              <div style="display: flex; justify-content: space-between; font-size: 12px; font-weight: 800;">
                <span>${s3.scorecard2.label}</span>
                <span style="color: #0284c7;">${s3.scorecard2.value}</span>
              </div>
              <div style="width: 100%; height: 6px; background: #e2e8f0; border-radius: 999px; overflow: hidden; margin-top: 3px;">
                <div style="width: ${s3.scorecard2.pct}%; height: 100%; background: #0284c7;"></div>
              </div>
            </div>
          </div>
        </div>

        <div class="wrapped-brutal-card" style="background: #111; color: #fff; padding: 10px 14px;">
          <div style="font-size: 11px; font-weight: 800; color: #00F59B;">
            ✨ ${s3.winTitle}:
          </div>
          <p style="font-size: 12px; font-weight: 600; color: #cbd5e1; margin-top: 3px;">
            ${s3.winBody}
          </p>
        </div>
      </div>

      <div style="text-align: center; font-size: 12px; font-weight: 800; color: rgba(0,0,0,0.6);">
        TAP TO UNLOCK DIET RECOMMENDATIONS &rarr;
      </div>
    </div>

    <!-- SLIDE 4: The Intelligent Gap & Culturally Tailored Swaps -->
    <div class="wrapped-slide wrapped-slide-4" data-slide="3">
      <div>
        <div class="wrapped-brutal-badge" style="background: #FFE600; color: #111;">
          💡 NUTRITION RECOMMENDATION
        </div>
        <h2 class="wrapped-font-grotesk" style="font-size: 30px; line-height: 1.05; font-weight: 900; margin-top: 12px; letter-spacing: -1px; text-transform: uppercase;">
          ${s4.title}
        </h2>
        <p style="font-size: 12px; font-weight: 600; margin-top: 6px; color: #f3e8ff;">
          ${s4.subtitle}
        </p>
      </div>

      <div style="display: flex; flex-direction: column; gap: 10px;">
        <div class="wrapped-brutal-card" style="background: #fff; color: #111; padding: 14px;">
          <div style="display: flex; align-items: center; justify-content: space-between;">
            <span class="wrapped-brutal-badge" style="background: #c084fc; color: #fff; font-size: 9px;">${s4.swap1.badge}</span>
            <span style="font-weight: 900; font-size: 11px; color: #7c3aed;">${s4.swap1.gain}</span>
          </div>
          <div style="font-weight: 800; font-size: 13px; margin-top: 6px;">
            ${s4.swap1.name}
          </div>
          <p style="font-size: 11px; color: #475569; font-weight: 600; margin-top: 3px;">
            ${s4.swap1.desc}
          </p>
        </div>

        <div class="wrapped-brutal-card" style="background: #fff; color: #111; padding: 14px;">
          <div style="display: flex; align-items: center; justify-content: space-between;">
            <span class="wrapped-brutal-badge" style="background: #fde047; color: #111; font-size: 9px;">${s4.swap2.badge}</span>
            <span style="font-weight: 900; font-size: 11px; color: #059669;">${s4.swap2.gain}</span>
          </div>
          <div style="font-weight: 800; font-size: 13px; margin-top: 6px;">
            ${s4.swap2.name}
          </div>
          <p style="font-size: 11px; color: #475569; font-weight: 600; margin-top: 3px;">
            ${s4.swap2.desc}
          </p>
        </div>
      </div>

      <div style="text-align: center; font-size: 12px; font-weight: 800; color: rgba(255,255,255,0.7);">
        TAP FOR OVER/UNDER ANALYSIS &rarr;
      </div>
    </div>

    <!-- SLIDE 5: Over/Under Intake -->
    <div class="wrapped-slide wrapped-slide-5" data-slide="4">
      <div>
        <div class="wrapped-brutal-badge" style="background: #fff; color: #111;">
          ⚖️ THE BALANCE BEAM
        </div>
        <h2 class="wrapped-font-grotesk" style="font-size: 30px; line-height: 1.05; font-weight: 900; margin-top: 12px; letter-spacing: -1px; text-transform: uppercase;">
          ${s5.title}
        </h2>
        <p style="font-size: 12px; font-weight: 600; margin-top: 6px; color: #ffe4e6;">
          ${s5.subtitle}
        </p>
      </div>

      <div style="display: flex; flex-direction: column; gap: 10px;">
        <div class="wrapped-brutal-card" style="background: #fff; color: #111;">
          <div style="display: flex; justify-content: space-between; align-items: baseline;">
            <span style="font-size: 11px; font-weight: 800; color: #64748b;">DAILY AVERAGE INTAKE</span>
            <span class="wrapped-brutal-badge" style="background: #fee2e2; color: #dc2626; font-size: 9px;">${s5.badge}</span>
          </div>
          <div class="wrapped-stat-hero-number" style="color: #FF3366; margin-top: 4px; font-size: 38px;">${s5.avgKcal}<span style="font-size: 18px;"> kcal</span></div>
          <p style="font-size: 11px; font-weight: 700; color: #475569; margin-top: 4px;">
            ${s5.targetDetail}
          </p>
        </div>

        <div class="wrapped-brutal-card" style="background: #111; color: #fff; border-color: #FFE600;">
          <div style="font-size: 10px; font-weight: 900; color: #FFE600; text-transform: uppercase;">
            🛡️ Weekend Strategy Prescription
          </div>
          <div style="font-size: 11px; font-weight: 600; color: #f1f5f9; margin-top: 6px; line-height: 1.4;">
            ${s5.prescriptionHtml}
          </div>
        </div>
      </div>

      <div style="text-align: center; font-size: 12px; font-weight: 800; color: rgba(255,255,255,0.7);">
        TAP TO REVEAL YOUR PERSONA &rarr;
      </div>
    </div>

    <!-- SLIDE 6: The Archetype Persona -->
    <div class="wrapped-slide wrapped-slide-6" data-slide="5">
      <div>
        <div class="wrapped-brutal-badge" style="background: #111; color: #00F0FF;">
          🧬 YOUR OFFICIAL PERSONA
        </div>
        <h2 class="wrapped-font-grotesk" style="font-size: 30px; line-height: 1.05; font-weight: 900; margin-top: 12px; letter-spacing: -1px; text-transform: uppercase;">
          ${s6.title}
        </h2>
        <p style="font-size: 12px; font-weight: 600; margin-top: 6px; color: #e0f2fe;">
          ${s6.subtitle}
        </p>
      </div>

      <div style="display: flex; flex-direction: column; gap: 10px;">
        <div class="wrapped-brutal-card" style="background: #fff; color: #111; text-align: center; padding: 16px;">
          <div style="font-size: 46px; filter: drop-shadow(0 4px 8px rgba(0,0,0,0.15));">${s6.emoji}</div>
          <div class="wrapped-font-grotesk" style="font-size: 18px; font-weight: 900; text-transform: uppercase; margin-top: 6px;">
            ${s6.archetypeName}
          </div>
          <div style="font-size: 11px; font-weight: 700; color: #64748b; margin-top: 3px;">
            &ldquo;${s6.quote}&rdquo;
          </div>

          <div style="display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; margin-top: 10px;">
            ${tagsHtml}
          </div>
        </div>

        <div class="wrapped-brutal-card" style="background: #111; color: #fff; padding: 10px 14px; display: flex; align-items: center; justify-content: space-between;">
          <div>
            <div style="font-size: 10px; font-weight: 800; color: #00F0FF;">MACROMIX SOCIETY TIER</div>
            <div style="font-size: 13px; font-weight: 900; color: #fff;">${s6.tier}</div>
          </div>
          <span style="font-size: 22px;">🛡️</span>
        </div>
      </div>

      <div style="text-align: center; font-size: 12px; font-weight: 800; color: rgba(255,255,255,0.7);">
        TAP FOR YOUR SHARE CARD &rarr;
      </div>
    </div>

    <!-- SLIDE 7: The Master Share Card -->
    <div class="wrapped-slide wrapped-slide-7" data-slide="6">
      <div>
        <div class="wrapped-brutal-badge" style="background: #FFE600; color: #111;">
          ✨ WEEKEND REVIEW SUMMARY
        </div>
        <h2 class="wrapped-font-grotesk" style="font-size: 30px; line-height: 1.05; font-weight: 900; margin-top: 10px; letter-spacing: -1px; text-transform: uppercase;">
          Your 7-Day<br><span style="background: #00F59B; color: #111; padding: 2px 8px; border-radius: 8px;">Report Card</span>
        </h2>
      </div>

      <!-- Master Shareable Card Preview -->
      <div class="wrapped-brutal-card" id="wrappedShareableCard" style="background: #182234; border-color: #FFE600; color: #fff; padding: 16px; box-shadow: 5px 5px 0px #FFE600;">
        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #334155; padding-bottom: 8px;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span style="font-size: 18px;">🥣</span>
            <span style="font-weight: 900; font-size: 14px; letter-spacing: -0.5px;">macromix wrapped</span>
          </div>
          <span class="wrapped-brutal-badge" style="background: #FFE600; color: #111; font-size: 9px;">${s7.handle}</span>
        </div>

        <div style="text-align: center; margin: 12px 0 10px;">
          <div style="font-size: 10px; font-weight: 800; color: #00F0FF; text-transform: uppercase;">WEEKLY PERSONA</div>
          <div class="wrapped-font-grotesk" style="font-size: 18px; font-weight: 900; color: #fff; margin-top: 2px;">
            ${s7.personaUpper}
          </div>
        </div>

        <!-- Stats Grid -->
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
          <div style="background: #0f172a; border: 2px solid #334155; border-radius: 10px; padding: 8px; text-align: center;">
            <div style="font-size: 18px; font-weight: 900; color: #FF3366;" class="wrapped-font-grotesk">${s7.stat1Val}</div>
            <div style="font-size: 9px; font-weight: 700; color: #94a3b8; text-transform: uppercase;">${s7.stat1Label}</div>
          </div>
          <div style="background: #0f172a; border: 2px solid #334155; border-radius: 10px; padding: 8px; text-align: center;">
            <div style="font-size: 18px; font-weight: 900; color: #00F59B;" class="wrapped-font-grotesk">${s7.stat2Val}</div>
            <div style="font-size: 9px; font-weight: 700; color: #94a3b8; text-transform: uppercase;">${s7.stat2Label}</div>
          </div>
          <div style="background: #0f172a; border: 2px solid #334155; border-radius: 10px; padding: 8px; text-align: center;">
            <div style="font-size: 18px; font-weight: 900; color: #FFE600;" class="wrapped-font-grotesk">${s7.stat3Val}</div>
            <div style="font-size: 9px; font-weight: 700; color: #94a3b8; text-transform: uppercase;">${s7.stat3Label}</div>
          </div>
          <div style="background: #0f172a; border: 2px solid #334155; border-radius: 10px; padding: 8px; text-align: center;">
            <div style="font-size: 18px; font-weight: 900; color: #A855F7;" class="wrapped-font-grotesk">${s7.stat4Val}</div>
            <div style="font-size: 9px; font-weight: 700; color: #94a3b8; text-transform: uppercase;">${s7.stat4Label}</div>
          </div>
        </div>
      </div>

      <div style="margin-top: 14px; width: 100%;">
        <button type="button" class="wrapped-cta-btn" id="wrappedCopyShareBtn" style="width: 100%; font-size: 14px; padding: 12px 18px;">
          <span>⚡</span> Share Story Card
        </button>
      </div>
    </div>
  `;
}

function updateWeekendWrappedVisibility() {
  const brand = document.getElementById('brand-wrapper');
  const isEligible = isWeekendWrappedEligible();
  if (brand) {
    if (isEligible && !isVisitorMode) {
      brand.classList.add('has-wrapped-story');
      brand.setAttribute('title', 'Watch Weekend Review Reel ✨');
      brand.setAttribute('aria-label', 'Watch Weekend Review Story Reel');
    } else {
      brand.classList.remove('has-wrapped-story');
      brand.setAttribute('title', 'Back to My Tracker');
      brand.setAttribute('aria-label', 'Back to My Tracker');
    }
  }
}

let _wrappedNavLock = false;

function safeAdvanceWrappedSlide(direction) {
  if (_wrappedNavLock) return;
  _wrappedNavLock = true;
  setTimeout(() => { _wrappedNavLock = false; }, 260);

  const total = document.querySelectorAll('.wrapped-slide').length;
  if (direction > 0) {
    if (wrappedCurrentSlide < total - 1) {
      goToWrappedSlide(wrappedCurrentSlide + 1);
    }
  } else if (direction < 0) {
    if (wrappedCurrentSlide > 0) {
      goToWrappedSlide(wrappedCurrentSlide - 1);
    } else {
      goToWrappedSlide(0);
    }
  }
}

function playWrappedTone(freq, type = 'sine', duration = 0.15) {
  if (!wrappedSoundEnabled) return;
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    if (!wrappedAudioCtx) wrappedAudioCtx = new AudioContext();
    if (wrappedAudioCtx.state === 'suspended') wrappedAudioCtx.resume();
    const osc = wrappedAudioCtx.createOscillator();
    const gain = wrappedAudioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, wrappedAudioCtx.currentTime);
    gain.gain.setValueAtTime(0.08, wrappedAudioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, wrappedAudioCtx.currentTime + duration);
    osc.connect(gain);
    gain.connect(wrappedAudioCtx.destination);
    osc.start();
    osc.stop(wrappedAudioCtx.currentTime + duration);
  } catch (e) {}
}

function showWrappedToast(text) {
  const toast = document.getElementById('wrappedToast');
  if (!toast) return;
  toast.textContent = text;
  toast.classList.add('show');
  playWrappedTone(660, 'sine', 0.15);
  setTimeout(() => toast.classList.remove('show'), 2400);
}

function updateWrappedSlideUI() {
  const slides = document.querySelectorAll('.wrapped-slide');
  const fills = document.querySelectorAll('.wrapped-fill');

  slides.forEach((slide, idx) => {
    slide.classList.remove('active', 'prev', 'next');
    if (idx === wrappedCurrentSlide) {
      slide.classList.add('active');
    } else if (idx < wrappedCurrentSlide) {
      slide.classList.add('prev');
    } else {
      slide.classList.add('next');
    }
  });

  if (wrappedCurrentSlide === slides.length - 1 && slides.length > 0) {
    if (currentUserHandle && window.MacromixFirebase && typeof window.MacromixFirebase.syncWeekendReviewCompleted === 'function') {
      window.MacromixFirebase.syncWeekendReviewCompleted(currentUserHandle);
    }
  }

  fills.forEach((fill, idx) => {
    fill.style.transition = 'none';
    if (idx < wrappedCurrentSlide) {
      fill.style.width = '100%';
    } else {
      fill.style.width = '0%';
    }
  });

  playWrappedTone(440 + (wrappedCurrentSlide * 60), 'triangle', 0.25);
}

function startWrappedSlideProgress() {
  cancelAnimationFrame(wrappedSlideTimer);
  wrappedStartTime = Date.now() - wrappedElapsed;
  const fills = document.querySelectorAll('.wrapped-fill');
  const slides = document.querySelectorAll('.wrapped-slide');
  const totalSlides = slides.length;
  const pauseBtn = document.getElementById('wrappedPauseBtn');

  function tick() {
    if (wrappedIsPaused) return;
    const now = Date.now();
    const elapsed = now - wrappedStartTime;
    const pct = Math.min(100, (elapsed / WRAPPED_SLIDE_DURATION_MS) * 100);

    if (fills[wrappedCurrentSlide]) {
      fills[wrappedCurrentSlide].style.transition = 'width 0.1s linear';
      fills[wrappedCurrentSlide].style.width = `${pct}%`;
    }

    if (elapsed >= WRAPPED_SLIDE_DURATION_MS) {
      if (wrappedCurrentSlide < totalSlides - 1) {
        goToWrappedSlide(wrappedCurrentSlide + 1);
      } else {
        wrappedIsPaused = true;
        if (pauseBtn) pauseBtn.textContent = '▶';
      }
    } else {
      wrappedSlideTimer = requestAnimationFrame(tick);
    }
  }
  wrappedSlideTimer = requestAnimationFrame(tick);
}

function goToWrappedSlide(idx) {
  cancelAnimationFrame(wrappedSlideTimer);
  wrappedSlideTimer = null;
  const slides = document.querySelectorAll('.wrapped-slide');
  const totalSlides = slides.length;
  if (idx < 0) idx = 0;
  if (idx >= totalSlides) idx = totalSlides - 1;
  wrappedCurrentSlide = idx;
  wrappedElapsed = 0;
  wrappedIsPaused = false;
  if (idx >= 1) {
    _wrappedSlideViewedCount++;
    markWeekendWrappedViewed(getWrappedActiveHandle());
  }
  const pauseBtn = document.getElementById('wrappedPauseBtn');
  if (pauseBtn) pauseBtn.textContent = '⏸';
  updateWrappedSlideUI();
  startWrappedSlideProgress();
}

function toggleWrappedPause() {
  wrappedIsPaused = !wrappedIsPaused;
  const pauseBtn = document.getElementById('wrappedPauseBtn');
  if (pauseBtn) pauseBtn.textContent = wrappedIsPaused ? '▶' : '⏸';
  if (!wrappedIsPaused) {
    wrappedStartTime = Date.now() - wrappedElapsed;
    startWrappedSlideProgress();
  } else {
    wrappedElapsed = Date.now() - wrappedStartTime;
  }
}

function openWeeklyWrappedModal(handleOverride) {
  const modal = document.getElementById('weekly-wrapped-modal');
  if (!modal || !modal.classList.contains('hidden')) return;
  const activeHandle = handleOverride || getWrappedActiveHandle();
  renderWeeklyWrappedSlides(activeHandle);
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  wrappedCurrentSlide = 0;
  wrappedElapsed = 0;
  wrappedIsPaused = false;
  _wrappedSlideViewedCount = 0;
  _wrappedOpenTime = Date.now();
  const pauseBtn = document.getElementById('wrappedPauseBtn');
  if (pauseBtn) pauseBtn.textContent = '⏸';
  updateWrappedSlideUI();
  startWrappedSlideProgress();
}

function closeWeeklyWrappedModal() {
  const modal = document.getElementById('weekly-wrapped-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  document.body.style.overflow = '';
  cancelAnimationFrame(wrappedSlideTimer);
  wrappedIsPaused = true;

  const elapsed = Date.now() - _wrappedOpenTime;
  if (_wrappedSlideViewedCount >= 1 || elapsed >= 2500 || wrappedCurrentSlide >= 1) {
    markWeekendWrappedViewed(getWrappedActiveHandle());
  }
  updateWeekendWrappedVisibility();
}

function triggerWrappedShare() {
  markWeekendWrappedViewed(getWrappedActiveHandle());
  const handle = getWrappedActiveHandle();
  if (currentUserHandle && window.MacromixFirebase && typeof window.MacromixFirebase.syncWeekendReviewShared === 'function') {
    window.MacromixFirebase.syncWeekendReviewShared(currentUserHandle);
  }
  const profile = WRAPPED_PROFILES[handle] || WRAPPED_PROFILES['istashmacros'];
  const text = profile.shareText;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => {
      showWrappedToast('Summary copied to clipboard! 🚀');
    }).catch(() => {
      showWrappedToast('Ready to share! ✨');
    });
  } else {
    showWrappedToast('Ready to share! ✨');
  }
}

function initWeekendWrappedEvents() {
  if (_wrappedEventsInitialized) return;
  _wrappedEventsInitialized = true;

  const closeBtn = document.getElementById('btn-close-wrapped');
  if (closeBtn) {
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeWeeklyWrappedModal();
    });
  }

  const soundBtn = document.getElementById('wrappedSoundBtn');
  if (soundBtn) {
    soundBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      wrappedSoundEnabled = !wrappedSoundEnabled;
      soundBtn.textContent = wrappedSoundEnabled ? '🔊' : '🔇';
      showWrappedToast(wrappedSoundEnabled ? 'Audio Sound FX On' : 'Audio Sound FX Muted');
    });
  }

  const pauseBtn = document.getElementById('wrappedPauseBtn');
  if (pauseBtn) {
    pauseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleWrappedPause();
    });
  }

  const tapLeft = document.getElementById('wrappedTapLeft');
  const tapRight = document.getElementById('wrappedTapRight');

  let holdTimer = null;
  let isHolding = false;
  let justReleasedHold = false;

  function bindStoryTapZone(el, direction) {
    if (!el) return;

    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.wrapped-header-actions') || e.target.closest('.wrapped-cta-btn')) return;
      isHolding = false;
      justReleasedHold = false;
      clearTimeout(holdTimer);
      holdTimer = setTimeout(() => {
        isHolding = true;
        if (!wrappedIsPaused) {
          wrappedIsPaused = true;
          wrappedElapsed = Date.now() - wrappedStartTime;
          cancelAnimationFrame(wrappedSlideTimer);
        }
      }, 400);
    });

    const releaseHold = () => {
      clearTimeout(holdTimer);
      if (isHolding) {
        isHolding = false;
        justReleasedHold = true;
        setTimeout(() => { justReleasedHold = false; }, 120);
        wrappedIsPaused = false;
        wrappedStartTime = Date.now() - wrappedElapsed;
        startWrappedSlideProgress();
      }
    };

    el.addEventListener('pointerup', releaseHold);
    el.addEventListener('pointercancel', releaseHold);

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (justReleasedHold) {
        justReleasedHold = false;
        return;
      }
      safeAdvanceWrappedSlide(direction);
    });
  }

  bindStoryTapZone(tapLeft, -1);
  bindStoryTapZone(tapRight, 1);

  const modal = document.getElementById('weekly-wrapped-modal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      const shareBtn = e.target.closest('#wrappedCopyShareBtn');
      if (shareBtn) {
        e.stopPropagation();
        triggerWrappedShare();
        return;
      }
      if (e.target === modal) {
        closeWeeklyWrappedModal();
      }
    });
  }

  window.addEventListener('keydown', (e) => {
    const m = document.getElementById('weekly-wrapped-modal');
    if (!m || m.classList.contains('hidden')) return;
    if (e.key === 'Escape') {
      closeWeeklyWrappedModal();
    } else if (e.key === 'ArrowRight' || e.key === 'KeyL') {
      safeAdvanceWrappedSlide(1);
    } else if (e.key === 'ArrowLeft' || e.key === 'KeyH') {
      safeAdvanceWrappedSlide(-1);
    } else if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      toggleWrappedPause();
    }
  });
}

async function handleLinkPasskey() {
  if (!currentUserHandle) {
    alert('Please log in or claim your handle first.');
    return;
  }
  try {
    await passkeyRegister(currentUserHandle);
    alert('Passkey linked successfully!');
  } catch (err) {
    alert('Could not link passkey: ' + (err.message || err));
  }
}

async function handleLinkGoogle() {
  if (!currentUserHandle) {
    alert('Please log in or claim your handle first.');
    return;
  }
  try {
    await handleGoogleAuth();
  } catch (err) {
    alert('Could not link Google account: ' + (err.message || err));
  }
}

async function handleSignOut() {
  if (!confirm('Are you sure you want to sign out?')) return;
  try {
    if (window.__macromixAuth && typeof window.__macromixAuth.signOut === 'function') {
      await window.__macromixAuth.signOut();
    }
  } catch (e) {}
  localStorage.removeItem('macromix_user_handle');
  currentUserHandle = null;
  clearRealtimeListeners(true);
  closeSettingsModal();
  const onboardingEl = document.getElementById('onboarding-screen');
  if (onboardingEl) {
    onboardingEl.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }
  const badgeEl = document.getElementById('tab-pill-me');
  if (badgeEl) badgeEl.style.display = 'none';
  AppLogger.log('AUTH', 'User signed out');
}

// ─── Accessible Event Handlers Setup (H9, M10, M11) ─────────────
function setupEventListeners() {
  const bind = (id, event, handler) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(event, handler);
  };

  bind('btn-onboard-google', 'click', handleGoogleAuth);
  bind('btn-onboard-passkey', 'click', handlePasskeyAuth);

  const brand = document.getElementById('brand-wrapper');
  if (brand) {
    brand.addEventListener('click', () => {
      if (brand.classList.contains('has-wrapped-story')) {
        openWeeklyWrappedModal();
        return;
      }
      switchTab('me');
      const scroller = document.getElementById('app-scroll-canvas');
      if (scroller) scroller.scrollTo({ top: 0, behavior: 'smooth' });
    });
    brand.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (brand.classList.contains('has-wrapped-story')) {
          openWeeklyWrappedModal();
          return;
        }
        switchTab('me');
        const scroller = document.getElementById('app-scroll-canvas');
        if (scroller) scroller.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  }

  bind('tab-pill-friends', 'click', handleHeaderFriendsClick);
  bind('tab-pill-me', 'click', () => {
    if (currentTab !== 'me' || isVisitorMode) switchTab('me');
  });

  const streak = document.getElementById('streak-badge');
  if (streak) {
    const triggerStreakPush = () => {
      streak.classList.add('badge-pushed');
      setTimeout(() => streak.classList.remove('badge-pushed'), 200);
    };
    streak.addEventListener('click', () => {
      triggerStreakPush();
      openSettingsModal();
    });
    streak.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        triggerStreakPush();
        openSettingsModal();
      }
    });
  }

  bind('btn-visitor-back', 'click', backToFriendsList);
  bind('btn-date-prev', 'click', () => {
    if (typeof triggerDeckSwipe === 'function') {
      triggerDeckSwipe(-1, 'prev');
    } else {
      changeDate(-1, 'prev');
    }
  });
  bind('date-label', 'click', resetToToday);
  bind('date-label-wrap', 'click', resetToToday);
  bind('btn-date-next', 'click', () => {
    if (typeof triggerDeckSwipe === 'function') {
      triggerDeckSwipe(1, 'next');
    } else {
      changeDate(1, 'next');
    }
  });
  bind('btn-tap-record', 'click', toggleVoiceRecording);

  const form = document.getElementById('text-log-form');
  if (form) form.addEventListener('submit', handleTextLog);

  bind('btn-share-profile', 'click', triggerProfileShare);

  const searchInput = document.getElementById('friend-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => handleFriendSearch(e.target.value));
  }

  bind('btn-close-settings', 'click', closeSettingsModal);
  bind('btn-save-targets', 'click', saveTargets);
  bind('btn-settings-admin', 'click', () => {
    closeSettingsModal();
    switchTab('admin');
  });
  bind('btn-settings-signout', 'click', handleSignOut);
  bind('btn-close-edit-modal', 'click', closeEditModal);
  bind('btn-save-item-edit', 'click', saveItemEdit);

  window.addEventListener('hashchange', () => {
    if (window.location.hash === '#admin') {
      if (currentUserHandle && currentUserHandle.toLowerCase() === 'satish') {
        switchTab('admin', false);
      }
    } else if (currentTab === 'admin') {
      switchTab('me', false);
    }
  });

  // PWA Install Prompt Listeners
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    checkAndTriggerInstallBanner(false);
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    localStorage.setItem('macromix_pwa_installed', 'true');
    updateTopAnnouncementBanner();
  });

  bind('btn-announcement-close', 'click', dismissActiveAnnouncementBanner);
  bind('btn-announcement-cta', 'click', handleActiveAnnouncementCta);
  bind('btn-pwa-install-close', 'click', dismissActiveAnnouncementBanner);
  bind('btn-pwa-install-action', 'click', handleActiveAnnouncementCta);
  bind('btn-close-ios-install', 'click', closeIosInstallModal);
  bind('btn-got-it-ios-install', 'click', closeIosInstallModal);

  // Keyboard accessibility: ESC key closes modals (M11)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSettingsModal();
      closeEditModal();
      closeIosInstallModal();
    }
  });
}

function openProfileSettings() {
  if (currentUserHandle) {
    alert(`Logged in as @${currentUserHandle}\nProtected by device biometric passkey.`);
  }
}

// Expose social controller methods on window
window.switchTab = switchTab;
window.triggerProfileShare = triggerProfileShare;
window.handleFriendSearch = handleFriendSearch;
window.viewFriendProfile = viewFriendProfile;
window.exitVisitorMode = exitVisitorMode;
window.backToFriendsList = backToFriendsList;
window.toggleFollowUser = toggleFollowUser;
window.loadMealLogs = loadMealLogs;
window.loadTargets = loadTargets;
window.clearRealtimeListeners = clearRealtimeListeners;
window.getCurrentLogs = () => currentLogs;
window.getMealsStorageKey = getMealsStorageKey;
window.handleHeaderFriendsClick = handleHeaderFriendsClick;
window.updateHeaderFriendsBtn = updateHeaderFriendsBtn;
window.renderCurrentUserStreak = renderCurrentUserStreak;
window.handleGoogleAuth = handleGoogleAuth;
window.handlePasskeyAuth = handlePasskeyAuth;
window.updateTopAnnouncementBanner = updateTopAnnouncementBanner;
window.triggerEmptyStateCardJiggle = triggerEmptyStateCardJiggle;
window.dismissActiveAnnouncementBanner = dismissActiveAnnouncementBanner;
window.handleActiveAnnouncementCta = handleActiveAnnouncementCta;
window.FEATURE_BANNERS = FEATURE_BANNERS;
window.setCardLoadingState = setCardLoadingState;
window.isLoadingMeals = () => isLoadingMeals;
window.openWeeklyWrappedModal = openWeeklyWrappedModal;
window.closeWeeklyWrappedModal = closeWeeklyWrappedModal;
window.isWeekendWrappedEligible = isWeekendWrappedEligible;
window.updateWeekendWrappedVisibility = updateWeekendWrappedVisibility;
window.renderWeeklyWrappedSlides = renderWeeklyWrappedSlides;
window.WRAPPED_PROFILES = WRAPPED_PROFILES;
window.getWrappedActiveHandle = getWrappedActiveHandle;
window.getWrappedCurrentSlide = () => wrappedCurrentSlide;
window.isWrappedPaused = () => wrappedIsPaused;
window.hasUserViewedWeekendWrapped = hasUserViewedWeekendWrapped;
window.markWeekendWrappedViewed = markWeekendWrappedViewed;
window.exitAdminDashboard = function() {
  switchTab('me', true);
  window.history.pushState(null, '', '/');
};

window.navigateToAdmin = function() {
  switchTab('admin', true);
};

// ─── PWA Launch Handler Consumer (Captures deep links into active PWA) ───
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (launchParams) => {
    if (!launchParams.targetURL) return;
    try {
      const url = new URL(launchParams.targetURL);
      const path = url.pathname.replace(/\/+$/, '');
      const match = path.match(/^\/?@?([a-zA-Z0-9_]{3,16})$/);
      if (match) {
        const handle = match[1].toLowerCase();
        const reserved = ['index', 'styles', 'app', 'sw', 'manifest', 'icons', 'api', 'favicon', 'admin'];
        if (!reserved.includes(handle)) {
          if (currentUserHandle && currentUserHandle.toLowerCase() === handle) {
            setVisitorMode(false);
            await switchTab('me');
          } else {
            await viewFriendProfile(handle);
          }
        }
      }
    } catch (e) {
      console.warn('[PWA] LaunchQueue consumer error:', e);
    }
  });
}



