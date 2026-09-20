// Whisper In-Browser Web Worker using Transformers.js (Universal classic worker)
importScripts('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js');

const { pipeline, env } = self.transformers;
env.allowLocalModels = false;
env.useBrowserCache = true;

// Use whisper-tiny.en (39MB quantized) for high speed and instant in-browser response
const MODEL_NAME = 'Xenova/whisper-tiny.en';
let transcriber = null;

self.addEventListener('message', async (event) => {
  const { type, audio, model } = event.data;
  const targetModel = model || MODEL_NAME;

  if (type === 'load') {
    try {
      self.postMessage({ status: 'loading', message: `Loading Whisper AI model (~35MB)...` });

      transcriber = await pipeline('automatic-speech-recognition', targetModel, {
        quantized: true,
        progress_callback: (p) => {
          if (p.status === 'progress') {
            const pct = typeof p.progress === 'number'
              ? Math.round(p.progress > 1 ? p.progress : p.progress * 100)
              : (p.loaded && p.total ? Math.round((p.loaded / p.total) * 100) : 0);

            self.postMessage({
              status: 'downloading',
              file: p.file || 'whisper-tiny.en',
              progress: pct
            });
          }
        }
      });

      self.postMessage({ status: 'ready', message: 'Whisper AI model ready (100% Local / Offline)!' });
    } catch (err) {
      console.error('Failed to load Whisper model in worker:', err);
      self.postMessage({ status: 'error', error: err.message || 'Worker load error' });
    }
  } else if (type === 'transcribe') {
    try {
      if (!transcriber) {
        self.postMessage({ status: 'transcribing', message: 'Initializing Whisper pipeline...' });
        transcriber = await pipeline('automatic-speech-recognition', targetModel, { quantized: true });
      }

      self.postMessage({ status: 'transcribing', message: 'Running Whisper local speech recognition...' });

      // Run inference on 16kHz audio array
      const output = await transcriber(audio, {
        chunk_length_s: 30,
        stride_length_s: 5,
        language: 'english',
        task: 'transcribe',
        return_timestamps: false
      });

      const text = (output.text || '').trim();
      self.postMessage({ status: 'complete', text });
    } catch (err) {
      console.error('Whisper transcription error in worker:', err);
      self.postMessage({ status: 'error', error: err.message || 'Transcription error' });
    }
  }
});
