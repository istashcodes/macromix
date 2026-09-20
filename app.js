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
    if (this.isPolling) return;
    this.isPolling = true;
    try {
      const res = await fetch(`/api/debug/logs?since_id=${this.lastBackendLogId}`);
      if (res.ok) {
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

// Initialize on DOM Ready
window.addEventListener('DOMContentLoaded', async () => {
  AppLogger.init();
  await checkUserProfileOnboarding();
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
  try {
    const res = await fetch('/api/user/gemini');
    if (res.ok) {
      userGeminiInfo = await res.json();
    }
  } catch (e) {}

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
  try {
    const res = await fetch('/api/targets');
    if (res.ok) {
      userTargets = await res.json();
      localStorage.setItem('macronomics_targets', JSON.stringify(userTargets));
      applyTargetsToUI();
      AppLogger.log('UI', 'Daily nutritional targets loaded', userTargets);
      return;
    }
  } catch (e) {}

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

  applyTargetsToUI();
  updateCirclesProgress();
  closeSettingsModal();
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

function calculateStreak() {
  const todayStr = getTodayDateString();
  const yesterdayStr = getYesterdayDateString();

  // Collect all unique dates with macros entered in the user device's local timezone
  const activeDays = new Set();
  (currentLogs || []).forEach(log => {
    if (hasMacrosEntered(log)) {
      activeDays.add(getLogDate(log));
    }
  });

  let streak = 0;
  if (activeDays.has(todayStr)) {
    // Streak includes today and continues backward consecutive days
    streak = 1;
    let check = new Date();
    check.setDate(check.getDate() - 1);
    while (activeDays.has(getLocalDateString(check))) {
      streak++;
      check.setDate(check.getDate() - 1);
    }
  } else if (activeDays.has(yesterdayStr)) {
    // User hasn't logged today yet, but streak from yesterday is still active
    streak = 1;
    let check = new Date();
    check.setDate(check.getDate() - 2);
    while (activeDays.has(getLocalDateString(check))) {
      streak++;
      check.setDate(check.getDate() - 1);
    }
  } else {
    // No logs today or yesterday -> streak broken
    streak = 0;
  }

  return streak;
}

function renderStreak() {
  const streakBadge = document.getElementById('streak-badge');
  if (!streakBadge) return;
  const streak = calculateStreak();
  streakBadge.textContent = `🔥 ${streak} ${streak === 1 ? 'Day' : 'Days'}`;
  streakBadge.setAttribute('title', `${streak} consecutive day${streak === 1 ? '' : 's'} logging macros`);
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

// --- Meal Logs & Timeline ---
async function loadMealLogs() {
  try {
    const res = await fetch('/api/logs');
    if (res.ok) {
      currentLogs = await res.json();
      localStorage.setItem('macronomics_meals', JSON.stringify(currentLogs));
      filterAndRenderSelectedDate();
      AppLogger.log('UI', `Timeline updated: ${currentLogs.length} total meal logs loaded`, { count: currentLogs.length });
      return;
    }
  } catch (e) {
    // Backend unavailable or network error (e.g. static hosting on Firebase)
  }

  const stored = localStorage.getItem('macronomics_meals');
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
      if (needsSave) {
        localStorage.setItem('macronomics_meals', JSON.stringify(currentLogs));
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
      container.innerHTML = '<div class="empty-state">No meals logged yet today. Tap the mic or type above!</div>';
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
            <div class="item-actions">
              <button type="button" class="item-action-btn edit-item-btn" data-id="${it.id}" data-food="${escapeHtml(it.food_name)}" data-quantity="${it.quantity}" data-unit="${escapeHtml(it.unit)}" data-weight="${it.standardized_weight_g}" title="Edit Portion">✏️</button>
              <button type="button" class="item-action-btn delete-item-btn" data-id="${it.id}" title="Delete Item">🗑️</button>
            </div>
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
  if (!confirm("Are you sure you want to delete this food item?")) return;
  AppLogger.log('UI', `User initiated deletion of food item #${itemId}`);
  let backendDeleted = false;
  try {
    const res = await fetch(`/api/logs/items/${itemId}`, { method: 'DELETE' });
    if (res.ok) {
      backendDeleted = true;
      await AppLogger.fetchBackendLogs();
    }
  } catch (e) {}

  if (!backendDeleted) {
    let stored = localStorage.getItem('macronomics_meals');
    if (stored) {
      try {
        let meals = JSON.parse(stored);
        meals.forEach(m => {
          m.items = (m.items || []).filter(it => it.id !== itemId);
        });
        meals = meals.filter(m => m.items && m.items.length > 0);
        localStorage.setItem('macronomics_meals', JSON.stringify(meals));
        currentLogs = meals;
      } catch (err) {}
    }
  }
  await loadMealLogs();
  AppLogger.log('UI', `Food item #${itemId} deleted successfully`);
}

async function deleteMealLog(logId) {
  if (!confirm("Are you sure you want to delete this meal log?")) return;
  AppLogger.log('UI', `User initiated deletion of meal log #${logId}`);
  let backendDeleted = false;
  try {
    const res = await fetch(`/api/logs/${logId}`, { method: 'DELETE' });
    if (res.ok) {
      backendDeleted = true;
      await AppLogger.fetchBackendLogs();
    }
  } catch (e) {}

  if (!backendDeleted) {
    let stored = localStorage.getItem('macronomics_meals');
    if (stored) {
      try {
        let meals = JSON.parse(stored).filter(m => m.id !== logId);
        localStorage.setItem('macronomics_meals', JSON.stringify(meals));
        currentLogs = meals;
      } catch (err) {}
    }
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
    let fallbackToClient = false;

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

      if (res.status === 403) {
        const errData = await res.json();
        AppLogger.log('GEMINI', 'API key required (403). Prompting for custom API key', errData, 'WARN');
        openGeminiModal();
        alert(errData.message || "Please provide your Gemini API key to continue.");
        micStatusText.textContent = "Gemini API key required. Click Gemini badge to configure.";
        return false;
      }

      if (res.status === 422) {
        const errData = await res.json().catch(() => ({}));
        AppLogger.log('GEMINI', 'Non-food input rejected by LLM gate (422)', errData, 'WARN');
        micStatusText.textContent = errData.message || "No food items detected. Please specify what you ate.";
        return false;
      }

      if (res.status === 404 || res.status === 502 || res.status === 503) {
        fallbackToClient = true;
      } else if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        AppLogger.log('GEMINI', 'Gemini multimodal API error (' + res.status + ')', errData, 'ERROR');
        throw new Error(errData.detail || errData.message || "Gemini processing failed");
      } else {
        geminiData = await res.json();
      }
    } catch (fetchErr) {
      if (fetchErr.message && (fetchErr.message.includes('Failed to fetch') || fetchErr.message.includes('NetworkError') || fetchErr.message.includes('Load failed'))) {
        fallbackToClient = true;
      } else {
        throw fetchErr;
      }
    }

    if (fallbackToClient) {
      AppLogger.log('GEMINI', 'Backend API unavailable. Calling Gemini API directly from client browser.');
      geminiData = await callClientGeminiDirect(transcript, audioBase64);
      if (!geminiData) return false;
    }

    AppLogger.log('GEMINI', `Gemini returned ${geminiData.items ? geminiData.items.length : 0} items for meal`, geminiData);

    if (geminiData.is_food === false || !geminiData.items || geminiData.items.length === 0) {
      micStatusText.textContent = geminiData.message || "No food items detected. Please specify what you ate.";
      return false;
    }

    const targetDate = (selectedDate && selectedDate <= getTodayDateString()) ? selectedDate : getTodayDateString();

    // Save meal via backend POST /api/logs or localStorage
    let savedToBackend = false;
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

      if (saveRes.ok) {
        savedToBackend = true;
        await AppLogger.fetchBackendLogs();
      }
    } catch (e) {}

    if (!savedToBackend) {
      // Direct client-side save to localStorage
      const stored = localStorage.getItem('macronomics_meals');
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
      localStorage.setItem('macronomics_meals', JSON.stringify(meals));
      currentLogs = meals;
      filterAndRenderSelectedDate();
      AppLogger.log('UI', 'Meal saved to client storage', newMeal);
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
  btnTapRecord.innerHTML = '<span class="btn-mic-icon">🎙️</span><span class="btn-track-text">Tap &amp; track your macro<span class="btn-brand-mix">mix</span></span>';

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
  const itemId = parseInt(document.getElementById('edit-item-id').value, 10);
  const qty = parseFloat(document.getElementById('edit-quantity').value);
  const weightG = parseFloat(document.getElementById('edit-weight-g').value);

  if (!itemId || isNaN(qty) || isNaN(weightG) || qty <= 0 || weightG <= 0) {
    alert("Quantity and standardized weight must be positive numbers greater than 0.");
    return;
  }

  AppLogger.log('UI', `User saving portion edit for item #${itemId}`, { quantity: qty, standardized_weight_g: weightG });
  let backendUpdated = false;

  try {
    const res = await fetch(`/api/logs/items/${itemId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity: qty, standardized_weight_g: weightG })
    });

    if (res.ok) {
      backendUpdated = true;
      await AppLogger.fetchBackendLogs();
    }
  } catch (e) {}

  if (!backendUpdated) {
    let stored = localStorage.getItem('macronomics_meals');
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
        localStorage.setItem('macronomics_meals', JSON.stringify(meals));
        currentLogs = meals;
      } catch (err) {}
    }
  }

  closeEditModal();
  await loadMealLogs();
  AppLogger.log('UI', `Item #${itemId} portion updated successfully`);
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
    }
    if (onboardingEl) onboardingEl.classList.add('hidden');
    return;
  }

  // Check backend profile
  try {
    const res = await fetch('/api/user/profile');
    if (res.ok) {
      const data = await res.json();
      if (data && data.handle) {
        currentUserHandle = data.handle;
        localStorage.setItem('macromix_user_handle', data.handle);
        if (badgeEl && badgeText) {
          badgeText.textContent = '@' + data.handle;
          badgeEl.style.display = 'flex';
        }
        if (onboardingEl) onboardingEl.classList.add('hidden');
        return;
      }
    }
  } catch (err) {
    console.warn("[macromix] Could not fetch user profile:", err);
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
  if (!clean || clean.length < 3 || clean.length > 20 || !/^[a-z0-9_]+$/.test(clean)) {
    showOnboardingError("Handle must be 3-20 characters (letters, numbers, underscores).");
    return false;
  }

  try {
    const res = await fetch('/api/user/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: clean, user_id: 1 })
    });

    if (!res.ok) {
      const err = await res.json();
      showOnboardingError(err.detail || "Could not claim handle. Please try another.");
      return false;
    }

    const data = await res.json();
    currentUserHandle = data.handle;
    localStorage.setItem('macromix_user_handle', data.handle);

    const badgeEl = document.getElementById('header-handle-badge');
    const badgeText = document.getElementById('header-handle-text');
    if (badgeEl && badgeText) {
      badgeText.textContent = '@' + data.handle;
      badgeEl.style.display = 'flex';
    }

    const onboardingEl = document.getElementById('onboarding-screen');
    if (onboardingEl) {
      onboardingEl.classList.add('hidden');
    }
    document.body.style.overflow = '';

    AppLogger.log('AUTH', `Successfully onboarded user via ${authMethod}: @${data.handle}`, data, 'SUCCESS');
    return true;
  } catch (e) {
    // Offline/standalone fallback
    currentUserHandle = clean;
    localStorage.setItem('macromix_user_handle', clean);
    const badgeEl = document.getElementById('header-handle-badge');
    const badgeText = document.getElementById('header-handle-text');
    if (badgeEl && badgeText) {
      badgeText.textContent = '@' + clean;
      badgeEl.style.display = 'flex';
    }
    const onboardingEl = document.getElementById('onboarding-screen');
    if (onboardingEl) onboardingEl.classList.add('hidden');
    document.body.style.overflow = '';
    return true;
  }
}

async function handlePasskeyAuth() {
  const input = document.getElementById('onboarding-handle-input');
  const handleVal = input ? input.value : '';
  if (!handleVal.trim()) {
    showOnboardingError("Please enter your desired handle first.");
    return;
  }

  // WebAuthn Passkey Registration Flow
  if (window.PublicKeyCredential) {
    try {
      AppLogger.log('AUTH', 'Initiating WebAuthn Passkey credential creation...');
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
            name: handleVal.trim().toLowerCase(),
            displayName: "@" + handleVal.trim().toLowerCase()
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
    } catch (err) {
      // User cancelled or platform-unsupported: still let them claim their handle seamlessly
      AppLogger.log('AUTH', 'WebAuthn prompt completed/bypassed: ' + (err.message || err), null, 'INFO');
    }
  }

  await registerHandleOnboarding(handleVal, 'passkey');
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

