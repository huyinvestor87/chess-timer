/**
 * app.js — DOM controller. Wires the pure ChessClockEngine to the screen,
 * settings storage, sound/vibration feedback, wake lock, and (optionally)
 * Firebase history. All actual timekeeping logic lives in timerEngine.js;
 * this file only reads snapshots and reacts to taps.
 */
// The ?v=__CACHE_VERSION__ query strings here (and on <link>/<script> tags in
// index.html) are cache-busting: the CI deploy step replaces the placeholder
// with the actual commit SHA, so every deploy gets fresh URLs for its JS/CSS
// instead of relying on browsers to notice unversioned files changed. See
// the "Stamp cache-busting version" step in .github/workflows/deploy.yml.
// Locally (npm run serve) the placeholder is left as-is, which is harmless —
// scripts/serve.mjs ignores query strings when resolving files on disk.
import { ChessClockEngine, TimerState } from './timerEngine.js?v=__CACHE_VERSION__';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, loadHistory, appendHistory, clearHistory } from './storage.js?v=__CACHE_VERSION__';
import * as feedback from './feedback.js?v=__CACHE_VERSION__';
import { WakeLockManager } from './wakeLock.js?v=__CACHE_VERSION__';
import { saveSessionToFirebase } from './firebaseHistory.js?v=__CACHE_VERSION__';

// ---------------------------------------------------------------- presets --

const PRESETS = [
  { id: '1min', label: '1 min', minutes: 1, incrementSec: 0 },
  { id: '1+1', label: '1 + 1', minutes: 1, incrementSec: 1 },
  { id: '2+1', label: '2 + 1', minutes: 2, incrementSec: 1 },
  { id: '3min', label: '3 min', minutes: 3, incrementSec: 0 },
  { id: '3+2', label: '3 + 2', minutes: 3, incrementSec: 2 },
  { id: '5min', label: '5 min', minutes: 5, incrementSec: 0 },
  { id: '5+3', label: '5 + 3', minutes: 5, incrementSec: 3 },
  { id: '10min', label: '10 min', minutes: 10, incrementSec: 0 },
  { id: '10+5', label: '10 + 5', minutes: 10, incrementSec: 5 },
  { id: '15+10', label: '15 + 10', minutes: 15, incrementSec: 10 },
  { id: '30min', label: '30 min', minutes: 30, incrementSec: 0 },
  { id: 'custom', label: 'Custom', minutes: null, incrementSec: null },
];

const LOW_TIME_WARN_MS = 60_000;
const LOW_TIME_CRITICAL_MS = 10_000;

// ------------------------------------------------------------------- state -

const engine = new ChessClockEngine();
const wakeLock = new WakeLockManager();
let settings = loadSettings();
let firstPlayer = settings.firstPlayer === 2 ? 2 : 1;
let selectedPresetId = settings.presetId || '5min';
// "Chấp giờ" (time handicap): lets player2 start with a different amount of
// time than player1. Increment/delay always stay shared between players.
let handicapEnabled = !!settings.handicapEnabled;
let pendingConfirmAction = null; // 'restart' | 'newTimer'
let lastWarnedSecond = { 1: null, 2: null };
let rafId = null;

// ------------------------------------------------------------------ dom refs -

const el = (id) => document.getElementById(id);

const dom = {
  screenSetup: el('screen-setup'),
  screenClock: el('screen-clock'),
  setupForm: el('setup-form'),
  presetGrid: el('preset-grid'),
  customFields: el('custom-fields'),
  customMinutes: el('input-custom-minutes'),
  customIncrement: el('input-custom-increment'),
  customDelay: el('input-custom-delay'),
  handicapInput: el('input-handicap'),
  handicapFields: el('handicap-fields'),
  handicapP1Minutes: el('input-handicap-p1-minutes'),
  handicapP2Minutes: el('input-handicap-p2-minutes'),
  handicapP1Label: el('handicap-p1-label'),
  handicapP2Label: el('handicap-p2-label'),
  player1NameInput: el('input-player1-name'),
  player2NameInput: el('input-player2-name'),
  soundInput: el('input-sound'),
  vibrationInput: el('input-vibration'),
  firstPlayerButtons: Array.from(document.querySelectorAll('[data-first-player]')),
  btnViewHistory: el('btn-view-history'),

  clockP1: el('clock-p1'),
  clockP2: el('clock-p2'),
  p1Name: el('display-p1-name'),
  p2Name: el('display-p2-name'),
  p1Time: el('display-p1-time'),
  p2Time: el('display-p2-time'),
  p1Moves: el('display-p1-moves'),
  p2Moves: el('display-p2-moves'),

  readyOverlay: el('ready-overlay'),
  readyFirstPlayerName: el('ready-first-player-name'),
  btnTapToStart: el('btn-tap-to-start'),

  btnPauseResume: el('btn-pause-resume'),
  btnUndo: el('btn-undo'),
  btnRestart: el('btn-restart'),
  btnSettings: el('btn-settings'),
  btnFullscreen: el('btn-fullscreen'),
  btnNewTimer: el('btn-new-timer'),

  modalSettings: el('modal-settings'),
  modalSoundInput: el('modal-input-sound'),
  modalVibrationInput: el('modal-input-vibration'),
  btnCloseSettings: el('btn-close-settings'),

  modalConfirmNew: el('modal-confirm-new'),
  confirmTitle: document.querySelector('#modal-confirm-new h2'),
  confirmBody: document.querySelector('#modal-confirm-new p'),
  btnConfirmCancel: el('btn-confirm-new-cancel'),
  btnConfirmOk: el('btn-confirm-new-ok'),

  modalExpired: el('modal-expired'),
  expiredTitle: el('expired-title'),
  expiredDetail: el('expired-detail'),
  btnExpiredUndo: el('btn-expired-undo'),
  btnExpiredRestart: el('btn-expired-restart'),
  btnExpiredNew: el('btn-expired-new'),

  modalHistory: el('modal-history'),
  historyList: el('history-list'),
  btnClearHistory: el('btn-clear-history'),
  btnCloseHistory: el('btn-close-history'),
};

// ------------------------------------------------------------------ helpers -

function formatClock(ms) {
  const total = Math.max(0, ms);
  if (total < LOW_TIME_CRITICAL_MS) {
    const seconds = Math.floor(total / 1000);
    const tenth = Math.floor((total % 1000) / 100);
    return `${seconds}.${tenth}`;
  }
  const totalSeconds = Math.floor(total / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function currentConfigFromForm() {
  const preset = PRESETS.find((p) => p.id === selectedPresetId);
  let startMs, incrementMs, delayMs;
  if (preset && preset.id !== 'custom') {
    startMs = preset.minutes * 60_000;
    incrementMs = preset.incrementSec * 1000;
    delayMs = 0;
  } else {
    startMs = Math.max(0, Number(dom.customMinutes.value || 0)) * 60_000;
    incrementMs = Math.max(0, Number(dom.customIncrement.value || 0)) * 1000;
    delayMs = Math.max(0, Number(dom.customDelay.value || 0)) * 1000;
  }
  const config = {
    player1Name: dom.player1NameInput.value.trim() || 'Player 1',
    player2Name: dom.player2NameInput.value.trim() || 'Player 2',
    startMs,
    incrementMs,
    delayMs,
    firstPlayer,
  };

  if (handicapEnabled) {
    config.player1StartMs = Math.max(0, Number(dom.handicapP1Minutes.value || 0)) * 60_000;
    config.player2StartMs = Math.max(0, Number(dom.handicapP2Minutes.value || 0)) * 60_000;
  }

  return config;
}

function persistSettingsFromForm() {
  const config = currentConfigFromForm();
  settings = {
    ...settings,
    player1Name: config.player1Name,
    player2Name: config.player2Name,
    startMs: config.startMs,
    incrementMs: config.incrementMs,
    delayMs: config.delayMs,
    firstPlayer: config.firstPlayer,
    presetId: selectedPresetId,
    soundEnabled: dom.soundInput.checked,
    vibrationEnabled: dom.vibrationInput.checked,
    handicapEnabled,
    player1StartMs: handicapEnabled ? config.player1StartMs : settings.player1StartMs,
    player2StartMs: handicapEnabled ? config.player2StartMs : settings.player2StartMs,
  };
  saveSettings(settings);
}

// -------------------------------------------------------------- setup screen -

function buildPresetGrid() {
  dom.presetGrid.innerHTML = '';
  for (const preset of PRESETS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preset-btn';
    btn.dataset.presetId = preset.id;
    btn.innerHTML = `<span class="preset-label">${preset.label}</span>`;
    btn.addEventListener('click', () => selectPreset(preset.id));
    dom.presetGrid.appendChild(btn);
  }
}

function selectPreset(id) {
  selectedPresetId = id;
  for (const btn of dom.presetGrid.children) {
    btn.classList.toggle('is-selected', btn.dataset.presetId === id);
  }
  dom.customFields.hidden = id !== 'custom';
}

function selectFirstPlayer(player) {
  firstPlayer = player;
  for (const btn of dom.firstPlayerButtons) {
    const isThis = Number(btn.dataset.firstPlayer) === player;
    btn.setAttribute('aria-pressed', String(isThis));
  }
}

function updateHandicapLabels() {
  const p1 = dom.player1NameInput.value.trim() || 'Player 1';
  const p2 = dom.player2NameInput.value.trim() || 'Player 2';
  dom.handicapP1Label.textContent = `${p1} minutes`;
  dom.handicapP2Label.textContent = `${p2} minutes`;
}

function setHandicapEnabled(enabled) {
  handicapEnabled = enabled;
  dom.handicapInput.checked = enabled;
  dom.handicapFields.hidden = !enabled;
  if (enabled) updateHandicapLabels();
}

dom.handicapInput.addEventListener('change', () => {
  const turningOn = dom.handicapInput.checked && !handicapEnabled;
  setHandicapEnabled(dom.handicapInput.checked);
  if (turningOn) {
    // Seed both fields from the currently selected preset/custom minutes so
    // there's a sensible starting point to adjust from, rather than blanks.
    const baseMinutes = dom.customMinutes.value || Math.round(settings.startMs / 60_000) || 5;
    const preset = PRESETS.find((p) => p.id === selectedPresetId);
    const minutes = preset && preset.id !== 'custom' ? preset.minutes : baseMinutes;
    dom.handicapP1Minutes.value = minutes;
    dom.handicapP2Minutes.value = minutes;
  }
});
dom.player1NameInput.addEventListener('input', updateHandicapLabels);
dom.player2NameInput.addEventListener('input', updateHandicapLabels);

function applySettingsToForm() {
  dom.player1NameInput.value = settings.player1Name === DEFAULT_SETTINGS.player1Name ? '' : settings.player1Name;
  dom.player2NameInput.value = settings.player2Name === DEFAULT_SETTINGS.player2Name ? '' : settings.player2Name;
  dom.soundInput.checked = settings.soundEnabled;
  dom.vibrationInput.checked = settings.vibrationEnabled;
  dom.customMinutes.value = Math.round(settings.startMs / 60_000) || 5;
  dom.customIncrement.value = Math.round(settings.incrementMs / 1000) || 0;
  dom.customDelay.value = Math.round(settings.delayMs / 1000) || 0;
  dom.handicapP1Minutes.value = Math.round(settings.player1StartMs / 60_000) || 5;
  dom.handicapP2Minutes.value = Math.round(settings.player2StartMs / 60_000) || 5;
  setHandicapEnabled(!!settings.handicapEnabled);
  selectPreset(PRESETS.some((p) => p.id === selectedPresetId) ? selectedPresetId : '5min');
  selectFirstPlayer(firstPlayer);
}

dom.setupForm.addEventListener('submit', (e) => {
  e.preventDefault();
  feedback.unlockAudio();
  persistSettingsFromForm();
  const config = currentConfigFromForm();
  engine.configure(config);
  showClockScreen();
});

dom.btnViewHistory.addEventListener('click', () => openHistoryModal());

// -------------------------------------------------------------- clock screen -

function showClockScreen() {
  dom.screenSetup.hidden = true;
  dom.screenClock.hidden = false;
  dom.readyFirstPlayerName.textContent = engine.config.firstPlayer === 1 ? engine.config.player1Name : engine.config.player2Name;
  dom.readyOverlay.hidden = false;
  lastWarnedSecond = { 1: null, 2: null };
  render(Date.now());
  startRenderLoop();
}

function showSetupScreen() {
  stopRenderLoop();
  wakeLock.disable();
  dom.screenClock.hidden = true;
  dom.screenSetup.hidden = false;
  applySettingsToForm();
}

function beginPlay() {
  feedback.unlockAudio();
  engine.start(Date.now());
  dom.readyOverlay.hidden = true;
  wakeLock.enable();
  render(Date.now());
}

dom.btnTapToStart.addEventListener('click', beginPlay);

function handlePress(player) {
  if (engine.state !== TimerState.RUNNING) return;
  const accepted = engine.press(player, Date.now());
  if (!accepted) return;
  if (settings.soundEnabled) feedback.playPressSound();
  if (settings.vibrationEnabled) feedback.vibratePress();
  render(Date.now());
  if (engine.state === TimerState.FINISHED) onExpired();
}

dom.clockP1.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  handlePress(1);
});
dom.clockP2.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  handlePress(2);
});

dom.btnPauseResume.addEventListener('click', () => {
  feedback.unlockAudio();
  const now = Date.now();
  if (engine.state === TimerState.RUNNING) {
    engine.pause(now);
    wakeLock.disable();
  } else if (engine.state === TimerState.PAUSED) {
    engine.resume(now);
    wakeLock.enable();
  }
  render(now);
});

function doUndo() {
  const wasFinished = engine.state === TimerState.FINISHED;
  const undone = engine.undo(Date.now());
  if (!undone) return false;
  if (wasFinished && engine.state !== TimerState.FINISHED) {
    dom.modalExpired.hidden = true;
    if (engine.state === TimerState.RUNNING) wakeLock.enable();
  }
  render(Date.now());
  return true;
}

dom.btnUndo.addEventListener('click', doUndo);
// The expired modal covers the whole screen (including the main control
// bar), so it needs its own Undo action — this is exactly the moment an
// accidental "clock press near zero" is most likely to need undoing.
dom.btnExpiredUndo.addEventListener('click', doUndo);

dom.btnRestart.addEventListener('click', () => {
  if (engine.state === TimerState.READY) {
    engine.restart();
    render(Date.now());
    return;
  }
  requestConfirm('restart');
});

dom.btnNewTimer.addEventListener('click', () => requestConfirm('newTimer'));

function requestConfirm(action) {
  pendingConfirmAction = action;
  if (action === 'restart') {
    dom.confirmTitle.textContent = 'Restart this timer?';
    dom.confirmBody.textContent = 'Both clocks will reset to the starting time. Move counts will be cleared.';
  } else {
    dom.confirmTitle.textContent = 'Start a new timer?';
    dom.confirmBody.textContent = 'This will discard the current clock and move counts.';
  }
  dom.modalConfirmNew.hidden = false;
}

dom.btnConfirmCancel.addEventListener('click', () => {
  dom.modalConfirmNew.hidden = true;
  pendingConfirmAction = null;
});

dom.btnConfirmOk.addEventListener('click', () => {
  dom.modalConfirmNew.hidden = true;
  if (pendingConfirmAction === 'restart') {
    engine.restart();
    dom.readyOverlay.hidden = false;
    dom.readyFirstPlayerName.textContent = engine.config.firstPlayer === 1 ? engine.config.player1Name : engine.config.player2Name;
    wakeLock.disable();
    render(Date.now());
  } else if (pendingConfirmAction === 'newTimer') {
    engine.newTimer();
    dom.modalExpired.hidden = true;
    showSetupScreen();
  }
  pendingConfirmAction = null;
});

dom.btnSettings.addEventListener('click', () => {
  dom.modalSoundInput.checked = settings.soundEnabled;
  dom.modalVibrationInput.checked = settings.vibrationEnabled;
  dom.modalSettings.hidden = false;
});
dom.btnCloseSettings.addEventListener('click', () => { dom.modalSettings.hidden = true; });
dom.modalSoundInput.addEventListener('change', () => {
  settings.soundEnabled = dom.modalSoundInput.checked;
  dom.soundInput.checked = settings.soundEnabled;
  saveSettings(settings);
});
dom.modalVibrationInput.addEventListener('change', () => {
  settings.vibrationEnabled = dom.modalVibrationInput.checked;
  dom.vibrationInput.checked = settings.vibrationEnabled;
  saveSettings(settings);
});

// ------------------------------------------------------------------ fullscreen -

function isFullscreenSupported() {
  const d = document.documentElement;
  return !!(d.requestFullscreen || d.webkitRequestFullscreen);
}

function isCurrentlyFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

async function toggleFullscreen() {
  const d = document.documentElement;
  try {
    if (!isCurrentlyFullscreen()) {
      if (d.requestFullscreen) await d.requestFullscreen();
      else if (d.webkitRequestFullscreen) d.webkitRequestFullscreen();
    } else if (document.exitFullscreen) {
      await document.exitFullscreen();
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
  } catch {
    // Fullscreen can be denied (e.g. not triggered by direct user gesture on
    // some browsers) — never let this break the timer.
  }
}

if (!isFullscreenSupported()) {
  dom.btnFullscreen.disabled = true;
} else {
  dom.btnFullscreen.addEventListener('click', toggleFullscreen);
}

// --------------------------------------------------------------- expiration -

function onExpired() {
  wakeLock.disable();
  if (settings.soundEnabled) feedback.playExpiredSound();
  if (settings.vibrationEnabled) feedback.vibrateExpired();

  const snap = engine.getSnapshot(Date.now());
  const expiredName = snap.expiredPlayer === 1 ? snap.player1Name : snap.player2Name;
  const otherName = snap.expiredPlayer === 1 ? snap.player2Name : snap.player1Name;
  const otherRemaining = snap.expiredPlayer === 1 ? snap.player2RemainingMs : snap.player1RemainingMs;

  dom.expiredTitle.textContent = `${expiredName}: Time Expired`;
  dom.expiredDetail.textContent = `${otherName} time remaining: ${formatClock(otherRemaining)}`;
  dom.btnExpiredUndo.disabled = !snap.canUndo;
  dom.modalExpired.hidden = false;

  const record = engine.toHistoryRecord();
  appendHistory(record);
  saveSessionToFirebase(record).catch(() => {});
}

dom.btnExpiredRestart.addEventListener('click', () => {
  dom.modalExpired.hidden = true;
  engine.restart();
  dom.readyOverlay.hidden = false;
  dom.readyFirstPlayerName.textContent = engine.config.firstPlayer === 1 ? engine.config.player1Name : engine.config.player2Name;
  render(Date.now());
});

dom.btnExpiredNew.addEventListener('click', () => {
  dom.modalExpired.hidden = true;
  engine.newTimer();
  showSetupScreen();
});

// --------------------------------------------------------------------- history -

function openHistoryModal() {
  const items = loadHistory();
  if (items.length === 0) {
    dom.historyList.innerHTML = '<div class="history-empty">No sessions yet. History fills in once a game ends (time expires).</div>';
  } else {
    dom.historyList.innerHTML = items.map(historyItemHtml).join('');
  }
  dom.modalHistory.hidden = false;
}

function historyItemHtml(item) {
  const date = item.endedAt ? new Date(item.endedAt).toLocaleString() : '';
  const expiredName = item.expiredPlayer === 1 ? item.player1Name : item.expiredPlayer === 2 ? item.player2Name : '—';
  const p1Min = Math.round((item.player1StartingTimeMs ?? 0) / 60000);
  const p2Min = Math.round((item.player2StartingTimeMs ?? 0) / 60000);
  // Only call out each player's starting time separately when it was a
  // handicap ("chấp giờ") match — otherwise show the single shared value.
  const startLabel = p1Min === p2Min ? `${p1Min}m` : `${p1Min}m/${p2Min}m (chấp giờ)`;
  return `<div class="history-item">
    <div class="history-row1"><span>${escapeHtml(item.player1Name)} vs ${escapeHtml(item.player2Name)}</span><span>${date}</span></div>
    <div class="history-row2">${expiredName} ran out · Moves ${item.player1Moves}/${item.player2Moves} · Start ${startLabel} +${Math.round(item.incrementMs / 1000)}s</div>
  </div>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

dom.btnCloseHistory.addEventListener('click', () => { dom.modalHistory.hidden = true; });
dom.btnClearHistory.addEventListener('click', () => {
  clearHistory();
  openHistoryModal();
});

// ------------------------------------------------------------------- render -

function warnClassFor(remainingMs) {
  if (remainingMs < LOW_TIME_CRITICAL_MS) return 'is-warn-critical';
  if (remainingMs < LOW_TIME_WARN_MS) return 'is-warn-low';
  return '';
}

function maybePlayLowTimeTick(player, remainingMs, isActive, running) {
  if (!running || !isActive) return;
  if (remainingMs >= LOW_TIME_CRITICAL_MS) {
    lastWarnedSecond[player] = null;
    return;
  }
  const second = Math.ceil(remainingMs / 1000);
  if (second !== lastWarnedSecond[player] && second > 0) {
    lastWarnedSecond[player] = second;
    if (settings.soundEnabled) feedback.playWarningTick();
    if (settings.vibrationEnabled) feedback.vibrateWarning();
  }
}

function updateHalf(playerNum, { nameEl, timeEl, movesEl, halfEl }, snap) {
  const name = playerNum === 1 ? snap.player1Name : snap.player2Name;
  const remaining = playerNum === 1 ? snap.player1RemainingMs : snap.player2RemainingMs;
  const moves = playerNum === 1 ? snap.player1Moves : snap.player2Moves;
  const isActive = snap.activePlayer === playerNum && (snap.state === TimerState.RUNNING || snap.state === TimerState.PAUSED);
  const isExpiredHere = snap.state === TimerState.FINISHED && snap.expiredPlayer === playerNum;

  setText(nameEl, name);
  setText(timeEl, formatClock(remaining));
  setText(movesEl, String(moves));

  halfEl.classList.toggle('is-active', isActive);
  halfEl.classList.toggle('is-inactive', !isActive && !isExpiredHere && snap.state !== TimerState.READY);
  halfEl.classList.toggle('is-expired', isExpiredHere);
  halfEl.classList.toggle('is-in-delay', isActive && snap.state === TimerState.RUNNING && snap.inDelay);

  const warn = isActive && snap.state === TimerState.RUNNING ? warnClassFor(remaining) : '';
  halfEl.classList.toggle('is-warn-low', warn === 'is-warn-low');
  halfEl.classList.toggle('is-warn-critical', warn === 'is-warn-critical');

  maybePlayLowTimeTick(playerNum, remaining, isActive, snap.state === TimerState.RUNNING);
}

function render(now) {
  const snap = engine.getSnapshot(now);

  updateHalf(1, { nameEl: dom.p1Name, timeEl: dom.p1Time, movesEl: dom.p1Moves, halfEl: dom.clockP1 }, snap);
  updateHalf(2, { nameEl: dom.p2Name, timeEl: dom.p2Time, movesEl: dom.p2Moves, halfEl: dom.clockP2 }, snap);

  dom.screenClock.classList.toggle('is-paused', snap.state === TimerState.PAUSED);

  dom.btnPauseResume.querySelector('.ctrl-label').textContent = snap.state === TimerState.PAUSED ? 'Resume' : 'Pause';
  dom.btnPauseResume.disabled = snap.state !== TimerState.RUNNING && snap.state !== TimerState.PAUSED;
  dom.btnUndo.disabled = !snap.canUndo;
}

// --------------------------------------------------------------- render loop -

function startRenderLoop() {
  if (rafId != null) return;
  const tick = () => {
    const now = Date.now();
    if (engine.state === TimerState.RUNNING) {
      const justExpired = engine.checkExpiration(now);
      if (justExpired) {
        render(now);
        onExpired();
        rafId = requestAnimationFrame(tick);
        return;
      }
    }
    render(now);
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

function stopRenderLoop() {
  if (rafId != null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

// Force an immediate, correct re-render the moment the tab regains focus —
// don't wait for the next animation frame, and don't rely on background
// timers (which browsers throttle/suspend) to have kept anything in sync.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !dom.screenClock.hidden) {
    const now = Date.now();
    if (engine.state === TimerState.RUNNING) {
      const justExpired = engine.checkExpiration(now);
      if (justExpired) onExpired();
    }
    render(now);
  }
});

// ------------------------------------------------------------------------ pwa -

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {
      // Offline support is a progressive enhancement — never block the app.
    });
  });
}

// ------------------------------------------------------------------------ init -

buildPresetGrid();
applySettingsToForm();
