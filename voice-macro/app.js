// Voice Macro AI - Standalone PWA Logic v1.0
// Powered by Transformers.js (Whisper Base WebGPU/WASM) + Google Gemini AI (gemini-2.0-flash)

const STORAGE_KEYS = {
  LOGS: 'voice_macro_daily_logs',
  TARGETS: 'voice_macro_targets',
  TRIAL_COUNT: 'voice_macro_trial_calls',
  USER_API_KEY: 'voice_macro_user_gemini_key',
  CACHE: 'voice_macro_transcript_cache',
  FREQUENT: 'voice_macro_frequent_meals',
  SPEECH_ENGINE: 'voice_macro_speech_engine' // 'whisper' or 'webspeech'
};

const DEFAULT_TARGETS = {
  cal: 2000,
  prot: 140,
  carb: 220,
  fat: 60,
  fib: 30
};

// Trial API Key fallback (must be provided via environment or settings, never committed)
const DEFAULT_TRIAL_KEY = '';
const MAX_TRIAL_CALLS = 0;

// State
let targets = JSON.parse(localStorage.getItem(STORAGE_KEYS.TARGETS)) || DEFAULT_TARGETS;
let dailyLogs = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOGS)) || {};
let transcriptCache = JSON.parse(localStorage.getItem(STORAGE_KEYS.CACHE)) || {};
let speechEngine = localStorage.getItem(STORAGE_KEYS.SPEECH_ENGINE) || 'whisper';
let frequentMeals = JSON.parse(localStorage.getItem(STORAGE_KEYS.FREQUENT)) || [
  { text: "1 scoop whey protein with water", cal: 120, prot: 24, carb: 2, fat: 1.5, meal: "Snacks" },
  { text: "3 scrambled eggs and 2 slices toast", cal: 360, prot: 22, carb: 26, fat: 16, meal: "Breakfast" },
  { text: "150g chicken breast with 1 cup rice", cal: 420, prot: 48, carb: 45, fat: 5, meal: "Lunch" }
];

let currentDateOffset = 0;
let isRecording = false;
let currentPendingMeal = null;
let lastLoggedMealSnapshot = null;
let undoTimeoutId = null;

// Speech Engines State
let audioContext = null;
let mediaStream = null;
let audioProcessor = null;
let audioChunks = [];
let webSpeechRecognition = null;
let webSpeechFinalText = '';

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
  initWebSpeech();
  renderDate();
  renderDashboard();
  renderFrequentChips();
  registerServiceWorker();
  logExecutionStep('sys', '✨ Gemini 2.0 Multimodal Voice AI ready (Direct Cloud Processing, 0MB Download).');
});

// Fallback Web Speech API
function initWebSpeech() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return;

  webSpeechRecognition = new SpeechRecognition();
  webSpeechRecognition.continuous = true;
  webSpeechRecognition.interimResults = true;
  webSpeechRecognition.lang = 'en-US';

  webSpeechRecognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; ++i) {
      if (event.results[i].isFinal) {
        webSpeechFinalText += ' ' + event.results[i][0].transcript;
      } else {
        interim += event.results[i][0].transcript;
      }
    }
    if (interim.trim()) {
      const hint = document.getElementById('hero-mic-hint');
      if (hint && isRecording) hint.innerText = `"${interim.trim().slice(-30)}"`;
    }
  };

  webSpeechRecognition.onerror = (e) => {
    console.warn("WebSpeech error:", e.error);
    stopVoiceRecording(false);
  };
}
// ==========================================
// UNIVERSAL 16-BIT PCM WAV ENCODER (PURE JS)
// ==========================================
function encodeWavBase64(chunks, sourceSampleRate = 44100, targetSampleRate = 16000) {
  // 1. Merge chunks
  let totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
  let merged = new Float32Array(totalLength);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }

  // 2. High quality linear resampling to 16kHz
  let resampled;
  if (!sourceSampleRate || sourceSampleRate === targetSampleRate) {
    resampled = merged;
  } else {
    let ratio = sourceSampleRate / targetSampleRate;
    let newLength = Math.round(merged.length / ratio);
    resampled = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
      let srcIdx = i * ratio;
      let srcIdxFloor = Math.floor(srcIdx);
      let srcIdxCeil = Math.min(srcIdxFloor + 1, merged.length - 1);
      let weight = srcIdx - srcIdxFloor;
      resampled[i] = merged[srcIdxFloor] * (1 - weight) + merged[srcIdxCeil] * weight;
    }
  }

  // 3. Construct standard 44-byte RIFF/WAVE header
  const buffer = new ArrayBuffer(44 + resampled.length * 2);
  const view = new DataView(buffer);

  function writeStr(offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + resampled.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM format sub-chunk size
  view.setUint16(20, 1, true); // Linear quantization (PCM)
  view.setUint16(22, 1, true); // Mono (1 channel)
  view.setUint32(24, targetSampleRate, true); // 16000 Hz
  view.setUint32(28, targetSampleRate * 2, true); // Byte rate (16000 * 1 * 2)
  view.setUint16(32, 2, true); // Block align (1 * 16 / 8)
  view.setUint16(34, 16, true); // Bits per sample
  writeStr(36, 'data');
  view.setUint32(40, resampled.length * 2, true);

  // 4. Write 16-bit signed PCM samples
  let p = 44;
  for (let i = 0; i < resampled.length; i++, p += 2) {
    let s = Math.max(-1, Math.min(1, resampled[i]));
    view.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }

  // 5. Convert to Base64 string
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ==========================================
// AUDIO RECORDING & TAP-TO-START / TAP-TO-FINISH
// ==========================================
async function toggleVoiceRecording() {
  if (!isRecording) {
    startVoiceRecording();
  } else {
    stopVoiceRecording(true);
  }
}

async function startVoiceRecording() {
  isRecording = true;
  updateMicUI('listening');
  webSpeechFinalText = '';
  audioChunks = [];
  logExecutionStep('mic', '🎙️ Microphone listening... Speak your food and portions (e.g. "2 boiled eggs and a banana")');

  // Start browser speech recognition in parallel for instant backup
  if (webSpeechRecognition) {
    try { webSpeechRecognition.start(); } catch (e) {}
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(mediaStream);
    
    // Collect PCM Float32 audio samples
    const bufferSize = 4096;
    audioProcessor = audioContext.createScriptProcessor(bufferSize, 1, 1);
    
    audioProcessor.onaudioprocess = (e) => {
      if (!isRecording) return;
      const inputData = e.inputBuffer.getChannelData(0);
      audioChunks.push(new Float32Array(inputData));
    };

    source.connect(audioProcessor);
    audioProcessor.connect(audioContext.destination);
  } catch (err) {
    console.warn("Microphone access error:", err);
    logExecutionStep('error', '⚠️ Microphone access error:', err.message);
    showToast("⚠️ Microphone access denied or unsupported.");
    stopVoiceRecording(false);
  }
}

function stopVoiceRecording(shouldProcess = true) {
  isRecording = false;

  if (webSpeechRecognition) {
    try { webSpeechRecognition.stop(); } catch (e) {}
  }

  const currentSampleRate = audioContext ? audioContext.sampleRate : 44100;

  if (audioProcessor) {
    try { audioProcessor.disconnect(); } catch (e) {}
    audioProcessor = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }
  if (audioContext) {
    try { audioContext.close(); } catch (e) {}
    audioContext = null;
  }

  if (shouldProcess && audioChunks.length > 0) {
    updateMicUI('processing');
    
    // Encode to 16kHz WAV
    const base64Wav = encodeWavBase64(audioChunks, currentSampleRate, 16000);
    const durationSec = ((audioChunks.reduce((acc, c) => acc + c.length, 0)) / currentSampleRate).toFixed(1);
    const wavSizeKb = Math.round((base64Wav.length * 3 / 4) / 1024);

    logExecutionStep('audio', `🛑 Recording captured (${durationSec}s audio, ${wavSizeKb} KB 16kHz WAV). Sending to Gemini Voice AI...`);
    processMultimodalVoiceAudio(base64Wav, webSpeechFinalText);
  } else {
    updateMicUI('idle');
  }
}

function cancelVoiceRecording() {
  stopVoiceRecording(false);
  updateMicUI('idle');
}

function updateMicUI(state) {
  const btn = document.getElementById('hero-mic-btn');
  const hint = document.getElementById('hero-mic-hint');
  if (!btn || !hint) return;

  if (state === 'listening' || state === true) {
    btn.classList.add('listening');
    btn.innerText = "🛑";
    hint.classList.add('listening');
    hint.innerText = "Tap to Finish Speaking";
  } else if (state === 'processing') {
    btn.classList.remove('listening');
    btn.innerText = "⏳";
    hint.classList.remove('listening');
    hint.innerText = "Analyzing meal with Gemini AI...";
  } else {
    btn.classList.remove('listening');
    btn.innerText = "🎙️";
    hint.classList.remove('listening');
    hint.innerText = "Tap to Talk Meal";
  }
}

// ==========================================
// DATE NAVIGATION
// ==========================================
function getDateKey(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function changeDateOffset(delta) {
  currentDateOffset += delta;
  renderDate();
  renderDashboard();
}

function renderDate() {
  const dateEl = document.getElementById('date-display');
  if (currentDateOffset === 0) {
    dateEl.innerText = "Today";
  } else if (currentDateOffset === -1) {
    dateEl.innerText = "Yesterday";
  } else if (currentDateOffset === 1) {
    dateEl.innerText = "Tomorrow";
  } else {
    const d = new Date();
    d.setDate(d.getDate() + currentDateOffset);
    dateEl.innerText = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }
}

// ==========================================
// GUARDRAILS & GEMINI 2.0 FLASH LLM PIPELINE
// ==========================================

// Layer 1: Client-Side Regex Pre-Filter (0ms, 0 API Cost)
function validateFoodIntent(rawTranscript) {
  const text = rawTranscript.toLowerCase().trim();
  
  const words = text.split(/\s+/).filter(w => w.length > 0);
  if (words.length < 2) {
    return {
      isValid: false,
      reason: "Please speak your food and portion (e.g. '2 boiled eggs and a banana')"
    };
  }

  const nonFoodRegex = /^(hello|hi|hey|good morning|good evening|who are you|what is the weather|tell me a joke|how are you|test|testing 1 2 3|what time is it|what is my name)\b/i;
  if (nonFoodRegex.test(text) && !text.includes('eat') && !text.includes('ate') && !text.includes('had') && !text.includes('drank')) {
    return {
      isValid: false,
      reason: "⚠️ Only food & beverage entries are logged. Try: 'I had 3 eggs and toast'"
    };
  }

  return { isValid: true };
}

// Layer 2: Smart Transcript Cache
function getCachedMeal(rawTranscript) {
  const normalizedKey = rawTranscript.toLowerCase().trim().replace(/^(i had|i ate|for breakfast i had|for lunch i had|for dinner i had)\s+/i, '');
  return transcriptCache[normalizedKey] || null;
}

function setCachedMeal(rawTranscript, mealData) {
  const normalizedKey = rawTranscript.toLowerCase().trim().replace(/^(i had|i ate|for breakfast i had|for lunch i had|for dinner i had)\s+/i, '');
  transcriptCache[normalizedKey] = mealData;
  localStorage.setItem(STORAGE_KEYS.CACHE, JSON.stringify(transcriptCache));
  updateFrequentMeals(rawTranscript, mealData);
}

function updateFrequentMeals(rawTranscript, mealData) {
  const cleanName = rawTranscript.trim();
  let totalCal = 0;
  let totalP = 0;
  let totalC = 0;
  let totalFat = 0;

  mealData.items.forEach(i => {
    totalCal += i.calories || 0;
    totalP += i.protein || 0;
    totalC += i.carbohydrates || 0;
    totalFat += i.fat || 0;
  });

  const existingIndex = frequentMeals.findIndex(f => f.text.toLowerCase() === cleanName.toLowerCase());
  if (existingIndex >= 0) {
    frequentMeals[existingIndex].count = (frequentMeals[existingIndex].count || 1) + 1;
  } else {
    frequentMeals.unshift({
      text: cleanName,
      cal: Math.round(totalCal),
      prot: Math.round(totalP),
      carb: Math.round(totalC),
      fat: Math.round(totalFat),
      meal: mealData.mealType || "Lunch",
      count: 1
    });
  }

  frequentMeals = frequentMeals.slice(0, 6);
  localStorage.setItem(STORAGE_KEYS.FREQUENT, JSON.stringify(frequentMeals));
  renderFrequentChips();
}

// ==========================================
// LIVE EXECUTION LOGGING CONSOLE & HELPERS
// ==========================================
function logExecutionStep(type, msg, detailsObj = null) {
  console.log(`[VoiceMacro][${type.toUpperCase()}] ${msg}`, detailsObj || '');
  const container = document.getElementById('execution-log-entries');
  if (!container) return;

  const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const row = document.createElement('div');
  row.className = `log-entry ${type}`;

  let detailsHtml = '';
  if (detailsObj) {
    if (typeof detailsObj === 'string') {
      detailsHtml = `<div class="log-details">${escapeHtml(detailsObj)}</div>`;
    } else {
      detailsHtml = `<pre class="log-json">${escapeHtml(JSON.stringify(detailsObj, null, 2))}</pre>`;
    }
  }

  row.innerHTML = `
    <div class="log-time-msg">
      <span class="log-time">${timeStr}</span>
      <span class="log-badge ${type}">${type.toUpperCase()}</span>
      <span class="log-msg">${escapeHtml(msg)}</span>
    </div>
    ${detailsHtml}
  `;

  container.appendChild(row);
  container.scrollTop = container.scrollHeight;
}

function clearExecutionLogs() {
  const container = document.getElementById('execution-log-entries');
  if (!container) return;
  container.innerHTML = `
    <div class="log-entry sys">
      <div class="log-time-msg">
        <span class="log-time">System</span>
        <span class="log-badge sys">READY</span>
        <span class="log-msg">Logs cleared. Tap mic to record meal speech...</span>
      </div>
    </div>
  `;
}

function toggleLogConsole() {
  const card = document.getElementById('execution-log-card');
  const btn = document.getElementById('toggle-logs-btn');
  if (!card) return;

  if (card.classList.contains('collapsed')) {
    card.classList.remove('collapsed');
    if (btn) btn.innerText = "Hide";
  } else {
    card.classList.add('collapsed');
    if (btn) btn.innerText = "Show";
  }
}

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// ==========================================
// SMART LOCAL NUTRITION PARSER (OFFLINE FALLBACK)
// ==========================================
function parseMealLocally(text) {
  const lower = text.toLowerCase();
  
  let mealType = inferCurrentMealCategory();
  if (lower.includes('breakfast')) mealType = 'Breakfast';
  else if (lower.includes('lunch')) mealType = 'Lunch';
  else if (lower.includes('dinner')) mealType = 'Dinner';
  else if (lower.includes('snack')) mealType = 'Snacks';

  const DB = [
    { patterns: [/(\d+)?\s*(boiled|fried|scrambled|poached)?\s*eggs?/i, /(\d+)?\s*eggs?/i], name: "Egg", unit: "large", cal: 74, p: 6.3, c: 0.4, f: 0, fat: 5 },
    { patterns: [/(\d+)?\s*egg\s*whites?/i], name: "Egg White", unit: "large", cal: 17, p: 3.6, c: 0.2, f: 0, fat: 0.1 },
    { patterns: [/(\d+)?\s*banana(s)?/i], name: "Banana", unit: "medium", cal: 105, p: 1.3, c: 27, f: 3.1, fat: 0.3 },
    { patterns: [/(\d+)?\s*apple(s)?/i], name: "Apple", unit: "medium", cal: 95, p: 0.5, c: 25, f: 4.4, fat: 0.3 },
    { patterns: [/(\d+)?\s*(slices?|pieces?)?\s*(of\s*)?(white|whole wheat|brown)?\s*toast/i, /(\d+)?\s*slices?\s*(of\s*)?bread/i], name: "Toast / Bread", unit: "slice", cal: 80, p: 3.2, c: 14.5, f: 1.2, fat: 1 },
    { patterns: [/(\d+)?\s*(scoop|servings?)?\s*(of\s*)?(whey|protein powder|protein shake)/i], name: "Whey Protein Shake", unit: "1 scoop (30g)", cal: 120, p: 24, c: 2.5, f: 0.5, fat: 1.5 },
    { patterns: [/(\d+)?\s*(g|grams|cup)?\s*(of\s*)?(grilled\s*)?chicken(\s*breast)?/i], name: "Chicken Breast", unit: "150g", cal: 240, p: 46, c: 0, f: 0, fat: 5 },
    { patterns: [/(\d+)?\s*(cup|bowl|g|grams)?\s*(of\s*)?(cooked\s*)?(white|brown|jasmine)?\s*rice/i], name: "Cooked Rice", unit: "1 cup (150g)", cal: 195, p: 4.2, c: 44, f: 1, fat: 0.5 },
    { patterns: [/(\d+)?\s*(cup|bowl|g|grams)?\s*(of\s*)?(oatmeal|oats)/i], name: "Oatmeal", unit: "1 cup cooked (40g dry)", cal: 150, p: 5.5, c: 27, f: 4, fat: 2.8 },
    { patterns: [/(\d+)?\s*(cup|glass)?\s*(of\s*)?(whole|skim|low-fat)?\s*milk/i], name: "Milk", unit: "1 cup (240ml)", cal: 125, p: 8, c: 12, f: 0, fat: 5 },
    { patterns: [/(\d+)?\s*(cup|mug)?\s*(of\s*)?(black\s*)?coffee/i], name: "Black Coffee", unit: "1 mug", cal: 5, p: 0.3, c: 0, f: 0, fat: 0 },
    { patterns: [/(\d+)?\s*(tbsp|tablespoons?|spoon)?\s*(of\s*)?peanut butter/i], name: "Peanut Butter", unit: "2 tbsp (32g)", cal: 190, p: 8, c: 7, f: 2, fat: 16 },
    { patterns: [/(\d+)?\s*(cup|bowl)?\s*(of\s*)?(greek\s*)?yogurt/i], name: "Greek Yogurt", unit: "1 cup (170g)", cal: 130, p: 17, c: 6, f: 0, fat: 3 },
    { patterns: [/(\d+)?\s*(cup|bowl)?\s*(of\s*)?salad/i], name: "Mixed Green Salad", unit: "1 bowl", cal: 65, p: 2, c: 8, f: 3, fat: 3 },
    { patterns: [/(\d+)?\s*(can|bottle)?\s*(of\s*)?(diet\s*)?(coke|soda)/i], name: "Soda / Beverage", unit: "1 can", cal: 0, p: 0, c: 0, f: 0, fat: 0 }
  ];

  let items = [];
  let detectedText = lower.replace(/^(i had|i ate|for breakfast|for lunch|for dinner|for snacks?|please log|i drank|consumed)\s+/gi, '');

  for (const entry of DB) {
    for (const pat of entry.patterns) {
      const match = detectedText.match(pat);
      if (match) {
        let count = 1;
        if (match[1] && !isNaN(parseInt(match[1]))) {
          count = parseInt(match[1]);
        }
        items.push({
          name: entry.name,
          portionDescription: `${count} ${entry.unit}`,
          carbohydrates: parseFloat((entry.c * count).toFixed(1)),
          protein: parseFloat((entry.p * count).toFixed(1)),
          fiber: parseFloat((entry.f * count).toFixed(1)),
          fat: parseFloat((entry.fat * count).toFixed(1)),
          calories: Math.round(entry.cal * count),
          description: `${count} ${entry.name}`
        });
        break;
      }
    }
  }

  if (items.length === 0) {
    const segments = detectedText.split(/\band\b|,|\+/i).map(s => s.trim()).filter(s => s.length > 0);
    segments.forEach(seg => {
      items.push({
        name: seg.charAt(0).toUpperCase() + seg.slice(1),
        portionDescription: "1 serving",
        carbohydrates: 20,
        protein: 10,
        fiber: 2,
        fat: 5,
        calories: 165,
        description: seg
      });
    });
  }

  return {
    isValidFood: true,
    mealType: mealType,
    items: items,
    totalMealCalories: items.reduce((sum, item) => sum + item.calories, 0)
  };
}

// ==========================================
// GEMINI MULTIMODAL VOICE AUDIO PIPELINE (SOLUTION A)
// ==========================================
async function processMultimodalVoiceAudio(base64Wav, rawSpokenFallbackText = '') {
  const userKey = localStorage.getItem(STORAGE_KEYS.USER_API_KEY);
  let trialCount = parseInt(localStorage.getItem(STORAGE_KEYS.TRIAL_COUNT) || '0', 10);

  let apiKeyToUse = userKey;
  if (!apiKeyToUse) {
    if (trialCount >= MAX_TRIAL_CALLS) {
      updateMicUI('idle');
      logExecutionStep('warn', '⚠️ Free trial calls reached. Please add your Gemini API Key in Settings.');
      openTrialModal();
      return;
    }
    apiKeyToUse = DEFAULT_TRIAL_KEY;
  }

  const promptText = `You are an authoritative clinical dietitian and voice meal extraction AI.
Listen carefully to the user's spoken voice audio describing their food consumption.

Your tasks:
1. Transcribe the exact words spoken into the "transcription" string field.
2. Determine if the recording is about food or beverage consumption. If NOT, return {"isValidFood": false, "reason": "not_food"}.
3. Infer the intended meal category ("Breakfast", "Lunch", "Snacks", or "Dinner") from spoken keywords or the current time of day (${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}).
4. For every distinct food/beverage item, calculate exact quantity, estimated grams, carbohydrates, protein, fiber, fat, and calories.
5. Return ONLY valid JSON matching this exact schema with numbers rounded to 1 decimal place:
{
  "transcription": "<exact spoken transcript>",
  "isValidFood": true,
  "mealType": "Breakfast" | "Lunch" | "Snacks" | "Dinner",
  "items": [
    {
      "name": "<Standard food name>",
      "portionDescription": "<e.g. 2 large, 1 scoop, 150g>",
      "estimatedGrams": <number or null>,
      "carbohydrates": <grams of carbs, number>,
      "protein": <grams of protein, number>,
      "fiber": <grams of fiber, number>,
      "fat": <grams of fat, number>,
      "calories": <kcal, number>,
      "description": "<short item summary>"
    }
  ],
  "totalMealCalories": <sum of calories, number>
}`;

  const models = ['gemini-2.0-flash', 'gemini-1.5-flash'];
  let successfulResult = null;
  let lastErrorMsg = null;

  logExecutionStep('llm', `🧠 Sending direct audio to Gemini Multimodal Voice AI (models: ${models.join(', ')})...`);

  for (const model of models) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 9000);

    try {
      const url = apiKeyToUse ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKeyToUse}` : '/geminiProxy';
      const payload = {
        model,
        contents: [
          {
            parts: [
              {
                inline_data: {
                  mime_type: "audio/wav",
                  data: base64Wav
                }
              },
              {
                text: promptText
              }
            ]
          }
        ],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.1
        }
      };

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        lastErrorMsg = `HTTP ${res.status}`;
        console.warn(`Gemini Audio ${model} HTTP ${res.status}:`, errText);
        continue;
      }

      const data = await res.json();
      if (data && data.candidates && data.candidates.length > 0 && data.candidates[0].content) {
        let text = data.candidates[0].content.parts[0].text.trim();
        text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
        const parsed = JSON.parse(text);

        if (parsed && parsed.isValidFood && Array.isArray(parsed.items) && parsed.items.length > 0) {
          successfulResult = parsed;
          logExecutionStep('llm', `✨ Gemini AI (${model}) processed voice audio successfully.`);
          break;
        }
      }
    } catch (e) {
      clearTimeout(timeoutId);
      lastErrorMsg = e.message;
      console.warn(`Error on multimodal ${model}:`, e);
    }
  }

  updateMicUI('idle');

  if (successfulResult && successfulResult.isValidFood && Array.isArray(successfulResult.items) && successfulResult.items.length > 0) {
    if (!userKey) {
      trialCount += 1;
      localStorage.setItem(STORAGE_KEYS.TRIAL_COUNT, trialCount.toString());
    }

    const finalTranscript = successfulResult.transcription || rawSpokenFallbackText || "Spoken Meal";
    logExecutionStep('v2t', '🗣️ Gemini transcribed voice words:', `"${finalTranscript}"`);
    logExecutionStep('meta', `📊 Extracted metadata for ${successfulResult.items.length} item(s):`, successfulResult);
    showConfirmationModal(finalTranscript, successfulResult);
  } else {
    // If Gemini audio fails (e.g. 403 API key or network) and we have Web Speech text or can prompt:
    const fallbackText = rawSpokenFallbackText || prompt("🎙️ Gemini Voice API note (" + (lastErrorMsg || "Key needed") + "). Please confirm what you ate:");
    if (fallbackText && fallbackText.trim()) {
      logExecutionStep('warn', `⚠️ Audio direct call error (${lastErrorMsg}). Running Smart Rule Parser on text...`);
      const fallbackResult = parseMealLocally(fallbackText.trim());
      logExecutionStep('meta', '📊 Extracted metadata via Smart Rule Engine:', fallbackResult);
      showConfirmationModal(fallbackText.trim(), fallbackResult);
    } else {
      showToast("⚠️ Could not process voice audio. Please try again.");
    }
  }
}

// Layer 3: Gemini 2.0 Flash / 1.5 Flash Text LLM Pipeline
async function processVoiceTranscript(rawTranscript) {
  logExecutionStep('v2t', '🗣️ Voice-to-Text conversion output:', `"${rawTranscript}"`);

  const preCheck = validateFoodIntent(rawTranscript);
  if (!preCheck.isValid) {
    updateMicUI('idle');
    logExecutionStep('warn', `⚠️ Food intent check: ${preCheck.reason}`);
    showToast(preCheck.reason);
    return;
  }

  const cached = getCachedMeal(rawTranscript);
  if (cached) {
    updateMicUI('idle');
    logExecutionStep('meta', '⚡ 0ms Cache hit! Retrieved instant metadata:', cached);
    showConfirmationModal(rawTranscript, cached);
    return;
  }

  const userKey = localStorage.getItem(STORAGE_KEYS.USER_API_KEY);
  let trialCount = parseInt(localStorage.getItem(STORAGE_KEYS.TRIAL_COUNT) || '0', 10);

  let apiKeyToUse = userKey;
  if (!apiKeyToUse) {
    if (trialCount >= MAX_TRIAL_CALLS) {
      updateMicUI('idle');
      logExecutionStep('warn', '⚠️ Free trial calls reached. Please add your Gemini API Key in Settings.');
      openTrialModal();
      return;
    }
    apiKeyToUse = DEFAULT_TRIAL_KEY;
  }

  const promptText = `You are an authoritative clinical dietitian and food intake extraction AI.
Analyze this spoken meal entry and extract every distinct food/beverage item with realistic macronutrients:
Transcript: "${rawTranscript}"

Current Time Context: ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}

Rules:
1. If the input is NOT about food or beverage consumption, return {"isValidFood": false, "reason": "not_food"}.
2. Infer the intended meal category ("Breakfast", "Lunch", "Snacks", or "Dinner") from spoken keywords or time of day.
3. For each food item, calculate exact grams, carbs (carbohydrates), protein, fiber, fat, and calories for the specified quantity.
4. Output ONLY valid JSON matching this exact schema with numbers rounded to 1 decimal place:
{
  "isValidFood": true,
  "mealType": "Breakfast" | "Lunch" | "Snacks" | "Dinner",
  "items": [
    {
      "name": "<Standard food name>",
      "portionDescription": "<e.g. 2 large, 1 scoop, 150g>",
      "estimatedGrams": <number or null>,
      "carbohydrates": <grams of carbs, number>,
      "protein": <grams of protein, number>,
      "fiber": <grams of fiber, number>,
      "fat": <grams of fat, number>,
      "calories": <kcal, number>,
      "description": "<short item summary>"
    }
  ],
  "totalMealCalories": <sum of calories, number>
}`;

  const models = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];
  let successfulResult = null;
  let lastErrorMsg = null;

  logExecutionStep('llm', `🧠 Extracting metadata with Gemini AI (models: ${models.join(', ')})...`);

  for (const model of models) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKeyToUse}`;
      const payload = {
        contents: [{ parts: [{ text: promptText }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.1
        }
      };

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        lastErrorMsg = `HTTP ${res.status}`;
        console.warn(`Gemini ${model} HTTP ${res.status}:`, errText);
        continue;
      }

      const data = await res.json();
      if (data && data.candidates && data.candidates.length > 0 && data.candidates[0].content) {
        let text = data.candidates[0].content.parts[0].text.trim();
        text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
        const parsed = JSON.parse(text);

        if (parsed && parsed.isValidFood && Array.isArray(parsed.items) && parsed.items.length > 0) {
          successfulResult = parsed;
          logExecutionStep('llm', `✨ Gemini AI (${model}) successfully parsed nutrition data.`);
          break;
        }
      }
    } catch (e) {
      clearTimeout(timeoutId);
      lastErrorMsg = e.message;
      console.warn(`Error on ${model}:`, e);
    }
  }

  updateMicUI('idle');

  if (successfulResult && successfulResult.isValidFood && Array.isArray(successfulResult.items) && successfulResult.items.length > 0) {
    if (!userKey) {
      trialCount += 1;
      localStorage.setItem(STORAGE_KEYS.TRIAL_COUNT, trialCount.toString());
    }

    logExecutionStep('meta', `📊 Extracted metadata for ${successfulResult.items.length} item(s):`, successfulResult);
    showConfirmationModal(rawTranscript, successfulResult);
  } else {
    // Graceful smart fallback parser so the user is never stuck!
    logExecutionStep('warn', `⚠️ Gemini API unavailable (${lastErrorMsg || 'No response'}). Running Smart Local Nutrition Engine fallback...`);
    const fallbackResult = parseMealLocally(rawTranscript);
    logExecutionStep('meta', `📊 Extracted metadata via Smart Rule Engine:`, fallbackResult);
    showConfirmationModal(rawTranscript, fallbackResult);
  }
}

// ==========================================
// VOICE CONFIRMATION MODAL
// ==========================================
function showConfirmationModal(rawTranscript, result) {
  currentPendingMeal = {
    rawTranscript: rawTranscript,
    mealData: JSON.parse(JSON.stringify(result))
  };

  logExecutionStep('sys', '✨ Opened confirmation modal. Confirm or adjust meal category to save.');

  // 1. Spoken speech quote
  const quoteEl = document.getElementById('confirm-spoken-text');
  if (quoteEl) {
    quoteEl.innerText = `"${rawTranscript}"`;
  }

  // 2. Meal category dropdown selection
  const mealSelect = document.getElementById('confirm-meal-select');
  if (mealSelect) {
    mealSelect.value = result.mealType || inferCurrentMealCategory();
  }

  // 3. Render Itemized Food Items List
  const itemsContainer = document.getElementById('confirm-items-container');
  if (itemsContainer) {
    itemsContainer.innerHTML = '';
    let totalCal = 0;
    let totalP = 0;
    let totalC = 0;
    let totalFib = 0;
    let totalFat = 0;

    result.items.forEach(item => {
      const cal = Math.round(item.calories || ((item.carbohydrates || 0) * 4 + (item.protein || 0) * 4 + (item.fat || 0) * 9));
      const p = parseFloat((item.protein || 0).toFixed(1));
      const c = parseFloat((item.carbohydrates || 0).toFixed(1));
      const f = parseFloat((item.fiber || 0).toFixed(1));
      const fat = parseFloat((item.fat || 0).toFixed(1));

      totalCal += cal;
      totalP += p;
      totalC += c;
      totalFib += f;
      totalFat += fat;

      const row = document.createElement('div');
      row.className = 'confirm-item-row';
      row.innerHTML = `
        <div style="flex: 1; padding-right: 8px;">
          <div class="confirm-item-name">
            <span>${item.name}</span>
            <span class="confirm-item-portion">(${item.portionDescription || (item.estimatedGrams ? item.estimatedGrams + 'g' : '1 serving')})</span>
          </div>
          <div class="confirm-item-macros">
            <span style="color: var(--prot-color);">🥩 ${p}g P</span>
            <span style="color: var(--carb-color);">🌾 ${c}g C</span>
            <span style="color: var(--fib-color);">🌱 ${f}g Fib</span>
            <span style="color: var(--fat-color);">🥑 ${fat}g F</span>
          </div>
        </div>
        <div style="font-weight: 800; color: var(--cal-color); font-size: 0.95rem; white-space: nowrap;">
          🔥 ${cal} kcal
        </div>
      `;
      itemsContainer.appendChild(row);
    });

    // 4. Render Totals Box
    const totalsBox = document.getElementById('confirm-totals-box');
    if (totalsBox) {
      totalsBox.innerHTML = `
        <div class="confirm-total-cal">🔥 ${Math.round(totalCal)} kcal</div>
        <div class="confirm-total-macros">
          <span style="color: var(--prot-color);">🥩 ${Math.round(totalP)}g P</span>
          <span style="color: var(--carb-color);">🌾 ${Math.round(totalC)}g C</span>
          <span style="color: var(--fib-color);">🌱 ${Math.round(totalFib)}g Fib</span>
          <span style="color: var(--fat-color);">🥑 ${Math.round(totalFat)}g F</span>
        </div>
      `;
    }
  }

  // 5. Reveal Modal
  const modal = document.getElementById('confirm-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeConfirmModal(event) {
  if (event && event.target.id !== 'confirm-modal' && !event.target.classList.contains('modal-close') && !event.target.classList.contains('btn-secondary')) return;
  const modal = document.getElementById('confirm-modal');
  if (modal) modal.classList.add('hidden');
  currentPendingMeal = null;
  logExecutionStep('sys', 'Confirmation modal closed / cancelled.');
}

function commitConfirmedMeal() {
  if (!currentPendingMeal) return;

  const mealSelect = document.getElementById('confirm-meal-select');
  const chosenCategory = mealSelect ? mealSelect.value : inferCurrentMealCategory();

  currentPendingMeal.mealData.mealType = chosenCategory;
  setCachedMeal(currentPendingMeal.rawTranscript, currentPendingMeal.mealData);
  commitMealToLog(currentPendingMeal.mealData, "✨ Voice AI");

  logExecutionStep('success', `✅ Confirmed & added meal to ${chosenCategory}!`, currentPendingMeal.mealData);

  const modal = document.getElementById('confirm-modal');
  if (modal) modal.classList.add('hidden');
  currentPendingMeal = null;
}

// ==========================================
// MEAL LOGGING & STATE MANAGEMENT
// ==========================================
function commitMealToLog(mealData, sourceLabel = "✨ Voice AI") {
  const dateKey = getDateKey(currentDateOffset);
  if (!dailyLogs[dateKey]) {
    dailyLogs[dateKey] = {
      Breakfast: [],
      Lunch: [],
      Snacks: [],
      Dinner: []
    };
  }

  const mealCategory = mealData.mealType || inferCurrentMealCategory();
  if (!dailyLogs[dateKey][mealCategory]) {
    dailyLogs[dateKey][mealCategory] = [];
  }

  lastLoggedMealSnapshot = {
    dateKey,
    category: mealCategory,
    itemIds: []
  };

  let totalAddedKcal = 0;
  let totalAddedP = 0;

  mealData.items.forEach(item => {
    const itemId = `v_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    const record = {
      id: itemId,
      name: item.name,
      portion: item.portionDescription || `${item.estimatedGrams || 100}g`,
      c: parseFloat((item.carbohydrates || 0).toFixed(1)),
      p: parseFloat((item.protein || 0).toFixed(1)),
      f: parseFloat((item.fiber || 0).toFixed(1)),
      fat: parseFloat((item.fat || 0).toFixed(1)),
      cal: Math.round(item.calories || ((item.carbohydrates * 4) + (item.protein * 4) + (item.fat * 9))),
      source: sourceLabel,
      addedAt: Date.now()
    };

    totalAddedKcal += record.cal;
    totalAddedP += record.p;
    dailyLogs[dateKey][mealCategory].push(record);
    lastLoggedMealSnapshot.itemIds.push(itemId);
  });

  localStorage.setItem(STORAGE_KEYS.LOGS, JSON.stringify(dailyLogs));
  renderDashboard();
  showUndoToast(`${sourceLabel}: +${totalAddedKcal} kcal (${Math.round(totalAddedP)}g P) in ${mealCategory}`);
}

function inferCurrentMealCategory() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 11) return "Breakfast";
  if (hour >= 11 && hour < 16) return "Lunch";
  if (hour >= 16 && hour < 19) return "Snacks";
  return "Dinner";
}

function undoLastLoggedMeal() {
  if (!lastLoggedMealSnapshot) return;
  const { dateKey, category, itemIds } = lastLoggedMealSnapshot;

  if (dailyLogs[dateKey] && dailyLogs[dateKey][category]) {
    dailyLogs[dateKey][category] = dailyLogs[dateKey][category].filter(item => !itemIds.includes(item.id));
    localStorage.setItem(STORAGE_KEYS.LOGS, JSON.stringify(dailyLogs));
    renderDashboard();
    showToast("↩️ Meal log undone successfully!");
  }
  lastLoggedMealSnapshot = null;
  clearTimeout(undoTimeoutId);
  const existingToast = document.getElementById('app-toast');
  if (existingToast) existingToast.remove();
}

function deleteFoodItem(mealCategory, itemId) {
  const dateKey = getDateKey(currentDateOffset);
  if (dailyLogs[dateKey] && dailyLogs[dateKey][mealCategory]) {
    dailyLogs[dateKey][mealCategory] = dailyLogs[dateKey][mealCategory].filter(i => i.id !== itemId);
    localStorage.setItem(STORAGE_KEYS.LOGS, JSON.stringify(dailyLogs));
    renderDashboard();
    showToast("🗑️ Item deleted");
  }
}

// ==========================================
// DASHBOARD RENDERING & MACRO RINGS
// ==========================================
function renderDashboard() {
  const dateKey = getDateKey(currentDateOffset);
  const dayData = dailyLogs[dateKey] || { Breakfast: [], Lunch: [], Snacks: [], Dinner: [] };

  let totalCal = 0;
  let totalP = 0;
  let totalC = 0;
  let totalFat = 0;
  let totalFib = 0;

  const categories = ["Breakfast", "Lunch", "Snacks", "Dinner"];
  const mealsContainer = document.getElementById('meals-container');
  mealsContainer.innerHTML = '';

  categories.forEach(cat => {
    const items = dayData[cat] || [];
    let catCal = 0;

    items.forEach(i => {
      catCal += (i.cal || 0);
      totalCal += (i.cal || 0);
      totalP += (i.p || 0);
      totalC += (i.c || 0);
      totalFat += (i.fat || 0);
      totalFib += (i.f || 0);
    });

    const mealSec = document.createElement('section');
    mealSec.className = 'meal-section';

    let itemsHtml = '';
    if (items.length === 0) {
      itemsHtml = `<div class="empty-meal-msg">No food logged yet for ${cat}. Tap mic below to speak.</div>`;
    } else {
      itemsHtml = items.map(item => `
        <div class="food-item-row">
          <div class="food-info">
            <div class="food-name">
              <span>${item.name}</span>
              <span class="food-portion">(${item.portion})</span>
            </div>
            <div class="food-macros">
              <span class="macro-tag cal">🔥 ${item.cal} kcal</span>
              <span class="macro-tag prot">🥩 ${item.p}g P</span>
              <span class="macro-tag carb">🌾 ${item.c}g C</span>
              <span class="macro-tag fat">🥑 ${item.fat}g F</span>
            </div>
          </div>
          <div class="food-actions">
            <button class="action-btn" title="Edit Item" onclick="openEditModal('${cat}', '${item.id}')">✏️</button>
            <button class="action-btn delete" title="Delete Item" onclick="deleteFoodItem('${cat}', '${item.id}')">✕</button>
          </div>
        </div>
      `).join('');
    }

    mealSec.innerHTML = `
      <div class="meal-header">
        <div class="meal-title-group">
          <span class="meal-name">${getMealEmoji(cat)} ${cat}</span>
          ${items.length > 0 ? `<span class="meal-summary-badge">🔥 ${Math.round(catCal)} kcal</span>` : ''}
        </div>
      </div>
      <div class="meal-items-list">${itemsHtml}</div>
    `;

    mealsContainer.appendChild(mealSec);
  });

  updateMacroRings(totalCal, totalP, totalC, totalFib, totalFat);
  renderStreak();
  renderTrendChart();
}

function getMealEmoji(cat) {
  switch (cat) {
    case 'Breakfast': return '🥣';
    case 'Lunch': return '🍳';
    case 'Snacks': return '☕';
    case 'Dinner': return '🍽️';
    default: return '🍴';
  }
}

function updateMacroRings(cal, prot, carb, fib, fat) {
  document.getElementById('val-cal').innerText = `${Math.round(cal)}`;
  document.getElementById('val-prot').innerText = `${Math.round(prot)}g`;
  document.getElementById('val-carb').innerText = `${Math.round(carb)}g`;
  document.getElementById('val-fib').innerText = `${Math.round(fib)}g`;
  document.getElementById('val-fat').innerText = `${Math.round(fat)}g`;

  document.getElementById('tgt-cal').innerText = `/ ${targets.cal} kcal`;
  document.getElementById('tgt-prot').innerText = `/ ${targets.prot}g`;
  document.getElementById('tgt-carb').innerText = `/ ${targets.carb}g`;
  document.getElementById('tgt-fib').innerText = `/ ${targets.fib || 30}g`;
  document.getElementById('tgt-fat').innerText = `/ ${targets.fat}g`;

  setRingOffset('ring-cal', cal, targets.cal);
  setRingOffset('ring-prot', prot, targets.prot);
  setRingOffset('ring-carb', carb, targets.carb);
  setRingOffset('ring-fib', fib, targets.fib || 30);
  setRingOffset('ring-fat', fat, targets.fat);
}

function setRingOffset(elementId, current, target) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const percentage = Math.min(Math.max((current / (target || 1)) * 100, 0), 100);
  const offset = 100 - percentage;
  el.style.strokeDashoffset = offset;
}

function renderStreak() {
  let streak = 0;
  let checkOffset = 0;

  while (true) {
    const k = getDateKey(checkOffset);
    const day = dailyLogs[k];
    if (!day) break;

    let dayCal = 0;
    Object.values(day).forEach(catItems => {
      catItems.forEach(i => dayCal += (i.cal || 0));
    });

    if (dayCal >= (targets.cal * 0.7)) {
      streak += 1;
      checkOffset -= 1;
    } else {
      if (checkOffset === 0) {
        checkOffset -= 1;
        continue;
      }
      break;
    }
  }

  document.getElementById('streak-badge').innerText = `🔥 ${streak} ${streak === 1 ? 'Day' : 'Days'}`;
}

function renderTrendChart() {
  const container = document.getElementById('trend-bars-container');
  if (!container) return;
  container.innerHTML = '';

  for (let i = -6; i <= 0; i++) {
    const k = getDateKey(i);
    const day = dailyLogs[k];
    let dayCal = 0;

    if (day) {
      Object.values(day).forEach(catItems => {
        catItems.forEach(item => dayCal += (item.cal || 0));
      });
    }

    const d = new Date();
    d.setDate(d.getDate() + i);
    const dayName = i === 0 ? "Today" : d.toLocaleDateString('en-US', { weekday: 'narrow' });

    const heightPct = Math.min(Math.round((dayCal / (targets.cal || 2000)) * 85), 100);

    const col = document.createElement('div');
    col.className = 'trend-col';
    col.innerHTML = `
      ${dayCal > 0 ? `<div class="trend-val-lbl">${Math.round(dayCal)}</div>` : ''}
      <div class="trend-bar-wrapper">
        <div class="trend-bar ${i === 0 ? 'current' : ''}" style="height: ${Math.max(heightPct, 5)}%;"></div>
      </div>
      <div class="trend-day-lbl">${dayName}</div>
    `;
    container.appendChild(col);
  }
}

function renderFrequentChips() {
  const container = document.getElementById('frequent-chips-container');
  if (!container) return;
  container.innerHTML = '';

  frequentMeals.forEach(meal => {
    const chip = document.createElement('button');
    chip.className = 'quick-chip';
    chip.innerHTML = `
      <span>${meal.text}</span>
      <span class="chip-cal">${meal.cal} kcal</span>
    `;
    chip.onclick = () => {
      logQuickChip(meal);
    };
    container.appendChild(chip);
  });
}

function logQuickChip(meal) {
  const mealData = {
    isValidFood: true,
    mealType: meal.meal || inferCurrentMealCategory(),
    items: [
      {
        name: meal.text,
        portionDescription: "1 serving",
        carbohydrates: meal.carb || 0,
        protein: meal.prot || 0,
        fiber: meal.fib || 0,
        fat: meal.fat || 0,
        calories: meal.cal || 0,
        description: meal.text
      }
    ]
  };
  commitMealToLog(mealData, "⚡ Quick Favorite");
}

// ==========================================
// TOAST & MODALS
// ==========================================
function showToast(message, duration = 3500) {
  let existing = document.getElementById('app-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'app-toast';
  toast.className = 'app-toast';
  toast.innerText = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    if (toast && toast.parentNode) toast.remove();
  }, duration);
}

function showUndoToast(message, duration = 5500) {
  let existing = document.getElementById('app-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'app-toast';
  toast.className = 'app-toast';
  toast.innerHTML = `
    <span>${message}</span>
    <button class="toast-undo-btn" onclick="undoLastLoggedMeal()">↩️ Undo</button>
  `;
  document.body.appendChild(toast);

  clearTimeout(undoTimeoutId);
  undoTimeoutId = setTimeout(() => {
    if (toast && toast.parentNode) toast.remove();
    lastLoggedMealSnapshot = null;
  }, duration);
}

function openSettingsModal() {
  document.getElementById('set-tgt-cal').value = targets.cal;
  document.getElementById('set-tgt-prot').value = targets.prot;
  document.getElementById('set-tgt-carb').value = targets.carb;
  document.getElementById('set-tgt-fib').value = targets.fib || DEFAULT_TARGETS.fib;
  document.getElementById('set-tgt-fat').value = targets.fat;
  document.getElementById('set-speech-engine').value = speechEngine;
  document.getElementById('custom-gemini-key').value = localStorage.getItem(STORAGE_KEYS.USER_API_KEY) || '';
  document.getElementById('settings-modal').classList.remove('hidden');
}

function closeSettingsModal(event) {
  if (event && event.target.id !== 'settings-modal' && !event.target.classList.contains('modal-close')) return;
  document.getElementById('settings-modal').classList.add('hidden');
}

function saveSettingsModal() {
  targets.cal = parseInt(document.getElementById('set-tgt-cal').value, 10) || DEFAULT_TARGETS.cal;
  targets.prot = parseInt(document.getElementById('set-tgt-prot').value, 10) || DEFAULT_TARGETS.prot;
  targets.carb = parseInt(document.getElementById('set-tgt-carb').value, 10) || DEFAULT_TARGETS.carb;
  targets.fib = parseInt(document.getElementById('set-tgt-fib').value, 10) || DEFAULT_TARGETS.fib;
  targets.fat = parseInt(document.getElementById('set-tgt-fat').value, 10) || DEFAULT_TARGETS.fat;
  localStorage.setItem(STORAGE_KEYS.TARGETS, JSON.stringify(targets));

  speechEngine = document.getElementById('set-speech-engine').value;
  localStorage.setItem(STORAGE_KEYS.SPEECH_ENGINE, speechEngine);

  const customKey = document.getElementById('custom-gemini-key').value.trim();
  if (customKey) {
    localStorage.setItem(STORAGE_KEYS.USER_API_KEY, customKey);
  } else {
    localStorage.removeItem(STORAGE_KEYS.USER_API_KEY);
  }

  closeSettingsModal();
  renderDashboard();
  showToast("⚙️ Settings saved successfully!");
}

function openTrialModal() {
  document.getElementById('trial-modal').classList.remove('hidden');
}

function closeTrialModal(event) {
  if (event && event.target.id !== 'trial-modal' && !event.target.classList.contains('modal-close')) return;
  document.getElementById('trial-modal').classList.add('hidden');
}

function saveTrialApiKey() {
  const key = document.getElementById('trial-api-key-input').value.trim();
  if (!key) {
    alert("Please enter a valid Gemini API key.");
    return;
  }
  localStorage.setItem(STORAGE_KEYS.USER_API_KEY, key);
  closeTrialModal();
  showToast("🔑 Key saved! Unlimited voice logging unlocked.");
}

function openEditModal(mealCategory, itemId) {
  const dateKey = getDateKey(currentDateOffset);
  const item = dailyLogs[dateKey]?.[mealCategory]?.find(i => i.id === itemId);
  if (!item) return;

  document.getElementById('edit-item-id').value = itemId;
  document.getElementById('edit-meal-key').value = mealCategory;
  document.getElementById('edit-food-name').value = item.name;
  document.getElementById('edit-food-portion').value = item.portion;
  document.getElementById('edit-food-prot').value = item.p;
  document.getElementById('edit-food-carb').value = item.c;
  document.getElementById('edit-food-fat').value = item.fat;
  document.getElementById('edit-food-fib').value = item.f || 0;

  document.getElementById('edit-modal').classList.remove('hidden');
}

function closeEditModal(event) {
  if (event && event.target.id !== 'edit-modal' && !event.target.classList.contains('modal-close')) return;
  document.getElementById('edit-modal').classList.add('hidden');
}

function saveEditedFoodItem() {
  const itemId = document.getElementById('edit-item-id').value;
  const mealCategory = document.getElementById('edit-meal-key').value;
  const dateKey = getDateKey(currentDateOffset);

  const item = dailyLogs[dateKey]?.[mealCategory]?.find(i => i.id === itemId);
  if (!item) return;

  item.name = document.getElementById('edit-food-name').value.trim();
  item.portion = document.getElementById('edit-food-portion').value.trim();
  item.p = parseFloat(document.getElementById('edit-food-prot').value) || 0;
  item.c = parseFloat(document.getElementById('edit-food-carb').value) || 0;
  item.fat = parseFloat(document.getElementById('edit-food-fat').value) || 0;
  item.f = parseFloat(document.getElementById('edit-food-fib').value) || 0;
  item.cal = Math.round((item.c * 4) + (item.p * 4) + (item.fat * 9));
  item.source = "✏️ Edited";

  localStorage.setItem(STORAGE_KEYS.LOGS, JSON.stringify(dailyLogs));
  closeEditModal();
  renderDashboard();
  showToast("✏️ Item updated!");
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js?v=1.0').catch(err => console.log('SW error:', err));
  }
}
