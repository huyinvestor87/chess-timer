/**
 * Sound + vibration feedback for clock presses and low-time warnings.
 * Uses the Web Audio API to synthesize short tones (no audio assets to
 * fetch, so it works fully offline) and the Vibration API where available.
 * Every call is defensive — a browser without AudioContext/vibrate support
 * must never throw or block clock presses.
 */

let audioCtx = null;

function getAudioContext() {
  if (audioCtx) return audioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  try {
    audioCtx = new Ctx();
  } catch {
    audioCtx = null;
  }
  return audioCtx;
}

/** Must be called from within a user-gesture handler on iOS/Safari. */
export function unlockAudio() {
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
}

function beep({ freq = 880, durationMs = 60, volume = 0.2, type = 'sine' } = {}) {
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.value = volume;
    osc.connect(gain).connect(ctx.destination);
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + durationMs / 1000);
    osc.start(now);
    osc.stop(now + durationMs / 1000 + 0.02);
  } catch {
    /* ignore — never let audio failures interrupt the clock */
  }
}

export function playPressSound() {
  beep({ freq: 720, durationMs: 55, volume: 0.18, type: 'square' });
}

export function playWarningTick() {
  beep({ freq: 1000, durationMs: 40, volume: 0.12, type: 'sine' });
}

export function playExpiredSound() {
  beep({ freq: 220, durationMs: 250, volume: 0.25, type: 'sawtooth' });
  setTimeout(() => beep({ freq: 165, durationMs: 350, volume: 0.25, type: 'sawtooth' }), 180);
}

export function vibratePress() {
  try {
    navigator.vibrate?.(15);
  } catch {
    /* ignore */
  }
}

export function vibrateWarning() {
  try {
    navigator.vibrate?.(20);
  } catch {
    /* ignore */
  }
}

export function vibrateExpired() {
  try {
    navigator.vibrate?.([120, 80, 120, 80, 200]);
  } catch {
    /* ignore */
  }
}
