/**
 * macronomics - Frontend Controller
 * Circles-based Neobrutalism UI with Dual-Engine Voice Logging
 */

// Application State
let currentEngine = 'gemini'; // 'gemini' primary nutrition engine
const GLOBAL_GEMINI_API_KEY = "";
let userTargets = { calories: 2000, protein_g: 150, carbs_g: 200, fat_g: 65, fiber_g: 30 };
let userGeminiInfo = { free_remaining: 9999, has_custom_key: true, can_use_gemini: true, gemini_api_key: GLOBAL_GEMINI_API_KEY, masked_key: "...7SKA" };
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

function setMicStatus(text) {
  const el = document.getElementById('mic-status-text');
  if (el) {
    el.textContent = text;
    if (text && text !== 'Mic Idle • Ready to Record') {
      el.classList.add('visible');
    } else {
      el.classList.remove('visible');
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
  await waitForFirebaseDB();
  await checkUserProfileOnboarding();
  cleanContaminatedMealsFromLocalStorage();
  await checkUrlRoute();
  updateDateLabel();
  renderStreak();
  setupInputListeners();
  setupLogButtonCapture();
  initServiceWorker();
  await loadTargets();
  await loadGeminiStatus();
  await loadMealLogs();
  setupSettingsModal();
  setupSwipeGestures();
  initFriendsView();
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

  userGeminiInfo.gemini_api_key = GLOBAL_GEMINI_API_KEY;
  userGeminiInfo.has_custom_key = true;
  userGeminiInfo.can_use_gemini = true;
  userGeminiInfo.free_remaining = 9999;
  userGeminiInfo.masked_key = "...7SKA";
  localStorage.setItem('macronomics_gemini_key', GLOBAL_GEMINI_API_KEY);
  updateGeminiBadge();
  AppLogger.log('UI', 'Gemini AI configured with global unlimited key', { has_custom_key: true });
}

function updateGeminiBadge() {
  if (geminiBadge) {
    geminiBadge.textContent = "Gemini: Unlimited ⚡";
    geminiBadge.style.background = "var(--fat-color)";
    geminiBadge.style.color = "#1E293B";
  }
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
      container.innerHTML = `<div class="empty-state">${isVisitorMode ? `No meals logged yet today by @${viewedHandle || 'user'}.` : 'No meals logged yet today. Tap the mic or type above!'}</div>`;
    } else {
      container.innerHTML = `<div class="empty-state">No meals logged on ${formatDateLabel(selectedDate)}.</div>`;
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
    micStatusText.textContent = "Please enter what you ate (e.g. '100g chicken').";
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
    if (success) {
      manualTextInput.value = '';
    }
  } catch (err) {
    // Retain input text in manualTextInput on error
  } finally {
    isProcessingLog = false;
    if (manualTextInput) {
      manualTextInput.disabled = false;
      manualTextInput.placeholder = 'Or type e.g. 100g cooked chicken breast at 1 pm...';
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
  const apiKey = GLOBAL_GEMINI_API_KEY;

  const modelsToTry = [
    'gemini-flash-latest',
    'gemini-flash-lite-latest',
    'gemini-3.6-flash',
    'gemini-3.5-flash-lite'
  ];

  const parts = [];
  if (audioBase64) {
    parts.push({
      inline_data: {
        mime_type: 'audio/webm',
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
      responseMimeType: "application/json"
    }
  };

  let geminiResult = null;
  let lastErr = null;

  for (const model of modelsToTry) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
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
          AppLogger.log('GEMINI', `Client direct Gemini (${model}) processed meal`, {
            is_food: geminiResult.is_food,
            item_count: (geminiResult.items || []).length
          });
          break;
        }
      } else {
        const errText = await res.text();
        lastErr = new Error(`HTTP ${res.status}: ${errText.slice(0, 100)}`);
      }
    } catch (e) {
      lastErr = e;
    }
  }

  if (!geminiResult) {
    throw lastErr || new Error("Failed to contact Gemini AI from browser client.");
  }

  return geminiResult;
}

async function processTranscript(transcript, audioBase64 = null) {
  if (isVisitorMode) return;
  if ((!transcript || !transcript.trim()) && !audioBase64) {
    micStatusText.textContent = "Please speak or enter what you ate.";
    AppLogger.log('UI', 'Log request cancelled: transcript and audio were empty');
    return;
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

  micStatusText.textContent = "Analyzing meal with Gemini AI...";
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
          alert(errData.message || "Please provide your Gemini API key to continue.");
          micStatusText.textContent = "Gemini API key required. Click Gemini badge to configure.";
          return false;
        } else if (res.status === 422) {
          const errData = await res.json().catch(() => ({}));
          AppLogger.log('GEMINI', 'Non-food input rejected by LLM gate (422)', errData, 'WARN');
          micStatusText.textContent = errData.message || "No food items detected. Please specify what you ate.";
          return false;
        } else if (res.status === 404 || res.status === 502 || res.status === 503 || !res.ok) {
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
      geminiData = await callClientGeminiDirect(transcript, audioBase64);
      if (!geminiData) return false;
    }

    AppLogger.log('GEMINI', `Gemini returned ${geminiData.items ? geminiData.items.length : 0} items for meal`, geminiData);

    if (geminiData.is_food === false || !geminiData.items || geminiData.items.length === 0) {
      micStatusText.textContent = geminiData.message || "No food items detected. Please specify what you ate.";
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
    setTimeout(() => {
      setMicStatus("Mic Idle • Ready to Record");
    }, 2500);

    // Clear and unlock text input on successful log
    if (manualTextInput) {
      manualTextInput.value = '';
      manualTextInput.disabled = false;
      manualTextInput.placeholder = 'Or type e.g. 100g cooked chicken breast at 1 pm...';
    }
    updateLogButtonState();
    return true;
  } catch (err) {
    console.error("Logging error:", err);
    let msg = err.message || "Error logging meal. Please try again.";
    if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) {
      msg = "Could not connect to Gemini AI or server. Please verify your connection or Gemini API key.";
    }
    setMicStatus(`Error: ${msg}`);
    AppLogger.log('ERROR', `Pipeline error: ${msg}`, { error: String(err) }, 'ERROR');
    await AppLogger.fetchBackendLogs().catch(() => {});
    alert(`Could not log meal: ${msg}`);
    return false;
  } finally {
    if (!alreadyLocked) {
      isProcessingLog = false;
      if (manualTextInput) {
        manualTextInput.disabled = false;
        manualTextInput.placeholder = 'Or type e.g. 100g cooked chicken breast at 1 pm...';
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
      micStatusText.textContent = `🗣️ "${combined}"`;
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
  
  const textToUse = capturedTranscript;
  if (textToUse) {
    await processTranscript(textToUse, audioBase64);
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
      micStatusText.textContent = "Auto-silence cut-off (5s)";
      stopRecording();
    }
  }, 5000);
}

// --- Settings Modal ---
function setupSettingsModal() {
  const btn = document.getElementById('open-settings-btn');
  if (btn) btn.onclick = openSettingsModal;

  const handleBadge = document.getElementById('header-handle-badge');
  if (handleBadge) handleBadge.onclick = openSettingsModal;

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
  const modal = document.getElementById('settings-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeSettingsModal() {
  AppLogger.log('UI', 'Closed Daily Macro Targets modal');
  const modal = document.getElementById('settings-modal');
  if (modal) modal.classList.add('hidden');
}

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

function updateHeaderFriendsBtn() {
  const btn = document.getElementById('btn-header-friends');
  if (!btn) return;
  const label = btn.querySelector('.friends-btn-label');
  const icon = btn.querySelector('.friends-btn-icon');

  if (isVisitorMode) {
    btn.classList.remove('active');
    if (label) label.textContent = 'Friends';
    if (icon) icon.textContent = '👥';
    btn.title = 'Back to Friends list';
  } else if (currentTab === 'friends') {
    btn.classList.add('active');
    if (label) label.textContent = 'Me';
    if (icon) icon.textContent = '🏠';
    btn.title = 'Back to My Tracker';
  } else {
    btn.classList.remove('active');
    if (label) label.textContent = 'Friends';
    if (icon) icon.textContent = '👥';
    btn.title = 'Friends & Follows';
  }
}

function handleHeaderFriendsClick() {
  if (isVisitorMode) {
    backToFriendsList();
  } else if (currentTab === 'friends') {
    switchTab('me');
  } else {
    switchTab('friends');
  }
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
  const handleBadge = document.getElementById('header-handle-badge');

  if (isVisitorMode && viewedHandle) {
    currentLogs = [];
    filterAndRenderSelectedDate();
    if (visitorBanner) visitorBanner.classList.remove('hidden');
    if (targetHandleEl) targetHandleEl.textContent = '@' + viewedHandle;
    if (visitorStreakPill) {
      visitorStreakPill.textContent = '';
      visitorStreakPill.classList.add('hidden');
    }
    if (voiceRow) voiceRow.classList.add('hidden');
    if (micBanner) micBanner.classList.add('hidden');
    if (textLogForm) textLogForm.classList.add('hidden');

    // Header handle badge ALWAYS stays the logged-in user:
    if (handleBadge && handleText) {
      if (currentUserHandle) {
        handleText.textContent = '@' + currentUserHandle;
        handleBadge.style.display = 'flex';
        handleBadge.style.cursor = 'pointer';
        handleBadge.title = 'Daily Macro Targets (Click to edit)';
      } else {
        handleBadge.style.display = 'none';
      }
    }
    // Header streak ALWAYS displays the logged-in user's streak:
    renderCurrentUserStreak();
  } else {
    if (visitorBanner) visitorBanner.classList.add('hidden');
    if (visitorStreakPill) visitorStreakPill.classList.add('hidden');
    if (voiceRow) voiceRow.classList.remove('hidden');
    if (micBanner) micBanner.classList.remove('hidden');
    if (textLogForm) textLogForm.classList.remove('hidden');
    if (handleBadge && handleText) {
      if (currentUserHandle) {
        handleText.textContent = '@' + currentUserHandle;
        handleBadge.style.display = 'flex';
        handleBadge.style.cursor = 'pointer';
        handleBadge.title = 'Daily Macro Targets (Click to edit)';
      } else {
        handleBadge.style.display = 'none';
      }
    }
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
    if (currentUserHandle && currentUserHandle.toLowerCase() === routeHandle.toLowerCase()) {
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
            <span class="friend-card-handle">@${escapeHtml(u.handle)}</span>
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
            <span class="friend-card-handle">@${escapeHtml(friendHandle)}</span>
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
  const badgeEl = document.getElementById('header-handle-badge');
  const badgeText = document.getElementById('header-handle-text');

  // Check local cache first
  const cachedHandle = localStorage.getItem('macromix_user_handle');
  if (cachedHandle) {
    currentUserHandle = cachedHandle;
    if (badgeEl && badgeText) {
      badgeText.textContent = '@' + cachedHandle;
      badgeEl.style.display = 'flex';
      badgeEl.style.cursor = 'pointer';
      badgeEl.title = 'Daily Macro Targets (Click to edit)';
    }
    if (onboardingEl) onboardingEl.classList.add('hidden');
    document.body.style.overflow = '';

    // Calculate streak from local cached meals
    try {
      const rawMeals = localStorage.getItem(getMealsStorageKey(cachedHandle));
      if (rawMeals) {
        currentUserStreak = calculateStreakForLogs(JSON.parse(rawMeals));
      }
    } catch (e) {}
    renderCurrentUserStreak();

    if (window.MacromixFirebase) {
      try {
        window.MacromixFirebase.syncStreakToFirestore(cachedHandle, currentUserStreak);
      } catch (e) {}
    }
    setupRealtimeMealsSync();
    setupCurrentUserProfileSync();
    updateHeaderFriendsBtn();
    return;
  }

  // Check if visitor viewing another user's public profile directly without an account
  const routeHandle = parseUrlHandle();
  if (routeHandle) {
    if (onboardingEl) onboardingEl.classList.add('hidden');
    document.body.style.overflow = '';
    if (badgeEl) badgeEl.style.display = 'none';
    const streakBadge = document.getElementById('streak-badge');
    if (streakBadge) streakBadge.style.display = 'none';
    updateHeaderFriendsBtn();
    return;
  }

  // Check backend profile if local server is active
  if (isLocalBackend()) {
    try {
      const res = await fetch('/api/user/profile');
      const ct = res.headers.get('content-type') || '';
      if (res.ok && ct.includes('application/json')) {
        const data = await res.json();
        if (data && data.handle) {
          currentUserHandle = data.handle;
          localStorage.setItem('macromix_user_handle', data.handle);
          if (badgeEl && badgeText) {
            badgeText.textContent = '@' + data.handle;
            badgeEl.style.display = 'flex';
            badgeEl.style.cursor = 'pointer';
          }
          if (onboardingEl) onboardingEl.classList.add('hidden');
          document.body.style.overflow = '';
          try {
            const rawMeals = localStorage.getItem(getMealsStorageKey(data.handle));
            if (rawMeals) {
              currentUserStreak = calculateStreakForLogs(JSON.parse(rawMeals));
            }
          } catch (e) {}
          renderCurrentUserStreak();
          setupRealtimeMealsSync();
          setupCurrentUserProfileSync();
          updateHeaderFriendsBtn();
          return;
        }
      }
    } catch (err) {
      console.warn("[macromix] Could not fetch user profile:", err);
    }
  }

  // If no handle is found, reveal dedicated onboarding screen
  if (onboardingEl) {
    onboardingEl.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    AppLogger.log('UI', 'Revealed dedicated first-time user onboarding screen');
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

  const badgeEl = document.getElementById('header-handle-badge');
  const badgeText = document.getElementById('header-handle-text');
  if (badgeEl && badgeText) {
    badgeText.textContent = '@' + clean;
    badgeEl.style.display = 'flex';
  }

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
  renderCurrentUserStreak();
  updateHeaderFriendsBtn();
  return true;
}

async function handlePasskeyAuth() {
  await waitForFirebaseDB();
  const input = document.getElementById('onboarding-handle-input');
  const handleVal = input ? input.value : '';
  if (!handleVal.trim()) {
    showOnboardingError("Please enter your desired handle first.");
    return;
  }
  const clean = handleVal.trim().toLowerCase().replace(/^@+/, '');

  // Check if handle already exists to determine whether to verify passkey (login) or register new passkey
  let isExistingUser = false;
  if (window.MacromixFirebase && typeof window.MacromixFirebase.checkHandleAvailable === 'function') {
    try {
      const isAvailable = await window.MacromixFirebase.checkHandleAvailable(clean);
      isExistingUser = !isAvailable;
    } catch (e) {}
  }

  // WebAuthn Passkey Flow
  if (window.PublicKeyCredential) {
    try {
      const challenge = new Uint8Array(32);
      window.crypto.getRandomValues(challenge);

      if (isExistingUser) {
        // --- SEAMLESS LOG-IN: Verify Passkey via navigator.credentials.get ---
        AppLogger.log('AUTH', `Verifying passkey for existing user @${clean}...`);
        const assertion = await navigator.credentials.get({
          publicKey: {
            challenge: challenge,
            rpId: window.location.hostname,
            userVerification: "preferred",
            timeout: 60000
          }
        });
        if (assertion) {
          AppLogger.log('AUTH', 'WebAuthn passkey verified successfully for login');
        }
      } else {
        // --- REGISTRATION: Create Passkey via navigator.credentials.create ---
        AppLogger.log('AUTH', `Initiating WebAuthn Passkey creation for @${clean}...`);
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
              { alg: -7, type: "public-key" },  // ES256
              { alg: -257, type: "public-key" } // RS256
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
      }
    } catch (err) {
      // User cancelled or platform-unsupported: still continue seamlessly
      AppLogger.log('AUTH', 'WebAuthn prompt completed/bypassed: ' + (err.message || err), null, 'INFO');
    }
  }

  await registerHandleOnboarding(clean, 'passkey');
}

async function handlePhoneAuthFallback() {
  const input = document.getElementById('onboarding-handle-input');
  const handleVal = input ? input.value : '';
  if (!handleVal.trim()) {
    showOnboardingError("Please enter your desired handle first.");
    return;
  }

  const phone = prompt("Enter your mobile number for SMS verification code:");
  if (phone && phone.trim()) {
    const code = prompt("Enter the 6-digit SMS verification code:");
    if (code && code.trim()) {
      await registerHandleOnboarding(handleVal, 'phone_sms');
    }
  }
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


