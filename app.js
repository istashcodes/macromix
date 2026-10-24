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
  const inputVal = manualTextInput ? manualTextInput.value.trim() : '';
  const canLog = inputVal.length > 0 && !isProcessingLog && !isRecording;
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
    setupSettingsModal();
    setupNotificationSettings();
    scheduleDailyReminderCheck();
    setupSwipeGestures();
    await initFriendsView();
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

function changeDate(offsetDays) {
  if (offsetDays > 0 && selectedDate >= getTodayDateString()) {
    return; // Next arrow is not clickable when on today
  }
  const parts = selectedDate.split('-');
  const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  d.setDate(d.getDate() + offsetDays);
  
  selectedDate = getLocalDateString(d);

  updateDateLabel();
  filterAndRenderSelectedDate();
  AppLogger.log('UI', `Date switched to ${selectedDate} (${formatDateLabel(selectedDate)})`);
}

function resetToToday() {
  selectedDate = getTodayDateString();
  updateDateLabel();
  filterAndRenderSelectedDate();
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

function updateDateLabel() {
  const labelEl = document.getElementById('date-label');
  if (labelEl) {
    labelEl.textContent = formatDateLabel(selectedDate);
  }
  updateDateNavButtons();
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

function filterAndRenderSelectedDate() {
  const filtered = currentLogs.filter(log => getLogDate(log) === selectedDate);
  renderTimeline(filtered);
  updateCirclesProgress(filtered);
  renderStreak();
}

function updateCirclesProgress(logsToUse = null) {
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

  if (calEl) calEl.textContent = totalCal;
  if (protEl) protEl.textContent = totalProt;
  if (carbEl) carbEl.textContent = totalCarb;
  if (fiberEl) fiberEl.textContent = totalFiber;
  if (fatEl) fatEl.textContent = totalFat;

  setCircleOffset('circle-cal', totalCal, userTargets.calories);
  setCircleOffset('circle-prot', totalProt, userTargets.protein_g);
  setCircleOffset('circle-carb', totalCarb, userTargets.carbs_g);
  setCircleOffset('circle-fiber', totalFiber, userTargets.fiber_g !== undefined ? userTargets.fiber_g : 30);
  setCircleOffset('circle-fat', totalFat, userTargets.fat_g);
}

function setCircleOffset(elementId, current, target) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const pct = Math.min(100, Math.max(0, (current / (target || 1)) * 100));
  const offset = 100 - pct;
  el.style.strokeDashoffset = offset;
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

function renderTimeline(logsToUse = null) {
  const container = document.getElementById('meal-timeline-content');
  if (!container) return;
  const logs = logsToUse !== null ? logsToUse : currentLogs.filter(l => getLogDate(l) === selectedDate);
  const validLogs = logs.filter(log => log.items && log.items.length > 0);
  if (!validLogs || validLogs.length === 0) {
    if (selectedDate === getTodayDateString()) {
      container.innerHTML = `<div class="empty-state">${isVisitorMode ? `No meals logged yet today by ${viewedHandle || 'user'}.` : 'No meals logged yet today. Tap the mic or type above!'}</div>`;
    } else {
      container.innerHTML = `<div class="empty-state">No meals logged ${formatDateLabel(selectedDate)}.</div>`;
    }
    return;
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

  container.innerHTML = html;
  setupTimelineDelegation();
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
  if (stored) {
    try {
      let meals = JSON.parse(stored);
      let parentMealId = null;
      let updatedParentMeal = null;
      meals.forEach(m => {
        if ((m.items || []).some(it => it.id === itemId)) {
          parentMealId = m.id;
          m.items = m.items.filter(it => it.id !== itemId);
          m.total_calories = Math.round((m.items || []).reduce((s, i) => s + (Number(i.calories) || 0), 0) * 10) / 10;
          m.total_protein_g = Math.round((m.items || []).reduce((s, i) => s + (Number(i.protein_g) || 0), 0) * 10) / 10;
          m.total_carbs_g = Math.round((m.items || []).reduce((s, i) => s + (Number(i.carbs_g) || 0), 0) * 10) / 10;
          m.total_fiber_g = Math.round((m.items || []).reduce((s, i) => s + (Number(i.fiber_g) || 0), 0) * 10) / 10;
          m.total_fat_g = Math.round((m.items || []).reduce((s, i) => s + (Number(i.fat_g) || 0), 0) * 10) / 10;
          if (m.items.length > 0) updatedParentMeal = m;
        }
      });
      meals = meals.filter(m => m.items && m.items.length > 0);
      localStorage.setItem(storageKey, JSON.stringify(meals));
      currentLogs = meals;

      if (currentUserHandle && window.MacromixFirebase && parentMealId) {
        if (updatedParentMeal) {
          window.MacromixFirebase.saveMealToFirestore(currentUserHandle, updatedParentMeal);
        } else {
          window.MacromixFirebase.deleteMealFromFirestore(currentUserHandle, parentMealId);
        }
      }
    } catch (err) {}
  }
  await loadMealLogs();
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

  if (currentUserHandle && window.MacromixFirebase) {
    window.MacromixFirebase.deleteMealFromFirestore(currentUserHandle, logId);
  }

  await loadMealLogs();
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
    submitBtn.classList.add('btn-disabled');
    submitBtn.style.pointerEvents = 'none';
    submitBtn.innerHTML = 'Logging... ⏳';
  }
  if (btnTapRecord) {
    btnTapRecord.disabled = true;
    btnTapRecord.classList.add('btn-disabled');
    btnTapRecord.style.pointerEvents = 'none';
  }

  manualTextInput.disabled = true;
  manualTextInput.placeholder = 'Logging meal...';

  try {
    const success = await processTranscript(text);
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
      submitBtn.innerHTML = 'Log ⚡';
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
    const safeMsg = lastErr ? (lastErr.message || '').replace(/<[^>]*>?/gm, '').trim() : '';
    throw new Error(safeMsg || "Gemini AI is currently busy. Please wait a few moments and try again.");
  }

  return geminiResult;
}

async function processTranscript(transcript, audioBase64 = null) {
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
      submitBtn.classList.add('btn-disabled');
      submitBtn.style.pointerEvents = 'none';
      submitBtn.innerHTML = 'Logging... ⏳';
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
      submitBtn.innerHTML = 'Log ⚡';
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

// --- Touch Swipe Gestures for Day Navigation ---
function setupSwipeGestures() {
  const swipeTargets = [
    document.querySelector('.circles-container'),
    document.querySelector('.main-container-card')
  ].filter(Boolean);

  swipeTargets.forEach(target => {
    let touchStartX = 0;
    let touchStartY = 0;
    let touchStartTime = 0;

    target.addEventListener('touchstart', (e) => {
      // Ignore if user touches an interactive control or inside an open modal
      if (e.target.closest('input, button, textarea, select, .modal-content, a')) {
        return;
      }
      if (e.touches.length === 1) {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        touchStartTime = Date.now();
      }
    }, { passive: true });

    target.addEventListener('touchend', (e) => {
      if (e.changedTouches.length === 1 && touchStartTime > 0) {
        const deltaX = e.changedTouches[0].clientX - touchStartX;
        const deltaY = e.changedTouches[0].clientY - touchStartY;
        const duration = Date.now() - touchStartTime;

        touchStartTime = 0;

        // Verify gesture: min distance 45px, predominantly horizontal, < 600ms
        if (Math.abs(deltaX) >= 45 && Math.abs(deltaX) > Math.abs(deltaY) * 1.3 && duration < 600) {
          if (deltaX > 0) {
            // Swiped right (dragging previous day in from left) -> Go to Previous Day
            changeDate(-1);
            AppLogger.log('UI', 'Swiped right: navigated to previous day');
          } else {
            // Swiped left (dragging next day in from right) -> Go to Next Day
            if (selectedDate < getTodayDateString()) {
              changeDate(1);
              AppLogger.log('UI', 'Swiped left: navigated to next day');
            }
          }
        }
      }
    }, { passive: true });
  });
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
    const title = 'Macromix Daily Reminder 🎯';
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
  document.getElementById('edit-quantity').value = qty;
  document.getElementById('edit-unit').value = unit;
  document.getElementById('edit-weight-g').value = weightG;

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
  const weightG = parseFloat(document.getElementById('edit-weight-g').value);

  if (!itemId || isNaN(qty) || isNaN(weightG) || qty <= 0 || weightG <= 0) {
    alert("Quantity and standardized weight must be positive numbers greater than 0.");
    return;
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
  if (stored) {
    try {
      let meals = JSON.parse(stored);
      meals.forEach(m => {
        let hasEdit = false;
        (m.items || []).forEach(it => {
          if (it.id === itemId) {
            const oldWeight = (it.standardized_weight_g && it.standardized_weight_g > 0) ? it.standardized_weight_g : weightG;
            const ratio = weightG / oldWeight;
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
        }
      });
      localStorage.setItem(storageKey, JSON.stringify(meals));
      currentLogs = meals;

      if (currentUserHandle && window.MacromixFirebase && typeof window.MacromixFirebase.saveMealToFirestore === 'function') {
        const editedMeal = meals.find(m => (m.items || []).some(it => it.id === itemId));
        if (editedMeal) {
          window.MacromixFirebase.saveMealToFirestore(currentUserHandle, editedMeal);
        }
      }
    } catch (err) {}
  }

  closeEditModal();
  await loadMealLogs();
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
    const reserved = ['index', 'styles', 'app', 'sw', 'manifest', 'icons', 'api', 'favicon'];
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
  const voiceRow = document.querySelector('.voice-buttons-row');
  const micBanner = document.getElementById('mic-status-text');
  const textLogForm = document.getElementById('text-log-form');
  const handleText = document.getElementById('header-handle-text');
  const pillMe = document.getElementById('tab-pill-me');

  // Always show/update the Me pill with the logged-in handle
  if (handleText && currentUserHandle) {
    handleText.textContent = currentUserHandle.replace(/^@+/, '');
  }
  if (pillMe) {
    pillMe.style.display = currentUserHandle ? '' : 'none';
  }

  if (isVisitorMode && viewedHandle) {
    currentLogs = [];
    filterAndRenderSelectedDate();
    if (visitorBanner) visitorBanner.classList.remove('hidden');
    if (targetHandleEl) targetHandleEl.textContent = viewedHandle;
    if (visitorStreakPill) {
      visitorStreakPill.textContent = '';
      visitorStreakPill.classList.add('hidden');
    }
    if (voiceRow) voiceRow.classList.add('hidden');
    if (micBanner) micBanner.classList.add('hidden');
    if (textLogForm) textLogForm.classList.add('hidden');
    // Header streak ALWAYS displays the logged-in user's streak:
    renderCurrentUserStreak();
  } else {
    if (visitorBanner) visitorBanner.classList.add('hidden');
    if (visitorStreakPill) visitorStreakPill.classList.add('hidden');
    if (voiceRow) voiceRow.classList.remove('hidden');
    if (micBanner) micBanner.classList.remove('hidden');
    if (textLogForm) textLogForm.classList.remove('hidden');
    // Clear visitor meals so they don't linger before owner's logs finish loading
    currentLogs = [];
    filterAndRenderSelectedDate();
    renderCurrentUserStreak();
  }

  updateHeaderFriendsBtn();
}


async function checkUrlRoute() {
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
      return;
    }

    if (viewMe) viewMe.classList.add('hidden');
    if (viewFriends) viewFriends.classList.remove('hidden');
    refreshFriendsView();
    updateHeaderFriendsBtn();
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
}

async function backToFriendsList() {
  window.history.pushState(null, '', '/');
  setVisitorMode(false);
  await switchTab('friends', false);
  updateHeaderFriendsBtn();
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
          <button type="button" class="btn-friend-action btn-macromix" onclick="viewFriendProfile('${escapeHtml(u.handle)}')">Macromix</button>
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
          <button type="button" class="btn-friend-action btn-macromix" onclick="viewFriendProfile('${escapeHtml(friendHandle)}')">Macromix</button>
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
    if (badgeText) badgeText.textContent = cachedHandle.replace(/^@+/, '');
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
  if (badgeText) badgeText.textContent = clean.replace(/^@+/, '');
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
  // Priority 1: New Feature Launch (Smart Notifications)
  {
    id: 'notifications_v1',
    icon: '🔔',
    title: 'Smart Reminders',
    desc: 'Custom times & streak alerts',
    ctaText: 'Turn On ⚡',
    isSatisfied: () => {
      if (typeof Notification === 'undefined') return true;
      return Notification.permission === 'granted' && localStorage.getItem('macromix_reminders_enabled') === 'true';
    },
    onAction: () => {
      openSettingsModal();
      setTimeout(() => {
        const modal = document.getElementById('settings-modal');
        if (modal) {
          const scrollable = modal.querySelector('.modal-content');
          const reminderCard = document.getElementById('settings-notification-status')?.closest('.form-group');
          if (scrollable && reminderCard) {
            scrollable.scrollTo({ top: reminderCard.offsetTop - 20, behavior: 'smooth' });
          } else if (scrollable) {
            scrollable.scrollTo({ top: 380, behavior: 'smooth' });
          }
        }
      }, 150);
    }
  },
  // Priority 2: PWA Installation
  {
    id: 'pwa_install',
    badge: 'PWA',
    icon: '📲',
    title: 'Install macromix',
    desc: 'Instant 1-tap logging, offline mode & home screen speed',
    ctaText: 'Install 📲',
    isSatisfied: () => isPwaInstalled(),
    onAction: () => {
      handlePwaInstallAction();
    }
  }
];

function updateTopAnnouncementBanner() {
  const container = document.getElementById('top-announcement-banner') || document.getElementById('pwa-install-banner');
  if (!container) return;

  // Don't show banners in visitor mode or before onboarding is completed
  if (isVisitorMode || !currentUserHandle) {
    container.classList.remove('visible');
    container.setAttribute('aria-hidden', 'true');
    currentActiveBannerId = null;
    return;
  }

  // Find the highest priority banner that is NOT satisfied and NOT snoozed
  let activeBanner = null;
  for (const b of FEATURE_BANNERS) {
    if (b.isSatisfied()) continue; // Completed / already active
    if (isBannerSnoozed(b.id)) continue; // Currently snoozed
    activeBanner = b;
    break; // Priority order: first match wins
  }

  if (!activeBanner) {
    container.classList.remove('visible');
    container.setAttribute('aria-hidden', 'true');
    currentActiveBannerId = null;
    return;
  }

  currentActiveBannerId = activeBanner.id;

  // Populate content
  const titleEl = document.getElementById('announcement-title');
  const badgeEl = document.getElementById('announcement-badge');
  const descEl = document.getElementById('announcement-desc');
  const iconEl = document.getElementById('announcement-icon');
  const ctaBtnText = document.getElementById('announcement-cta-text');

  if (titleEl) titleEl.textContent = activeBanner.title;
  if (badgeEl) {
    if (activeBanner.badge) {
      badgeEl.textContent = activeBanner.badge;
      badgeEl.style.display = '';
    } else {
      badgeEl.textContent = '';
      badgeEl.style.display = 'none';
    }
  }
  if (descEl) descEl.textContent = activeBanner.desc;
  if (iconEl) iconEl.textContent = activeBanner.icon;
  if (ctaBtnText) ctaBtnText.textContent = activeBanner.ctaText;

  // Animate in
  container.classList.add('visible');
  container.setAttribute('aria-hidden', 'false');
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
    brand.addEventListener('click', () => switchTab('me'));
    brand.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        switchTab('me');
      }
    });
  }

  bind('tab-pill-friends', 'click', handleHeaderFriendsClick);
  bind('tab-pill-me', 'click', () => {
    if (currentTab !== 'me' || isVisitorMode) switchTab('me');
  });

  const streak = document.getElementById('streak-badge');
  if (streak) {
    streak.addEventListener('click', openSettingsModal);
    streak.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openSettingsModal();
      }
    });
  }

  bind('btn-visitor-back', 'click', backToFriendsList);
  bind('btn-date-prev', 'click', () => changeDate(-1));
  bind('date-label', 'click', resetToToday);
  bind('btn-date-next', 'click', () => changeDate(1));
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
  bind('btn-settings-signout', 'click', handleSignOut);
  bind('btn-close-edit-modal', 'click', closeEditModal);
  bind('btn-save-item-edit', 'click', saveItemEdit);

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
window.dismissActiveAnnouncementBanner = dismissActiveAnnouncementBanner;
window.handleActiveAnnouncementCta = handleActiveAnnouncementCta;
window.FEATURE_BANNERS = FEATURE_BANNERS;

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
        const reserved = ['index', 'styles', 'app', 'sw', 'manifest', 'icons', 'api', 'favicon'];
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



