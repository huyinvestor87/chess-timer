/**
 * Local persistence: settings and session history via localStorage.
 * Everything here is synchronous and works fully offline — the app must
 * never depend on Firebase (or any network) for these.
 */

const SETTINGS_KEY = 'chessClockTimer.settings.v1';
const HISTORY_KEY = 'chessClockTimer.history.v1';
const MAX_LOCAL_HISTORY = 100;

export const DEFAULT_SETTINGS = {
  player1Name: 'Player 1',
  player2Name: 'Player 2',
  startMs: 5 * 60 * 1000,
  incrementMs: 0,
  delayMs: 0,
  firstPlayer: 1,
  soundEnabled: true,
  vibrationEnabled: true,
  presetId: '5min',
  // "Chấp giờ" (time handicap): when enabled, each player gets their own
  // starting time instead of both sharing the preset/custom value above.
  handicapEnabled: false,
  player1StartMs: 5 * 60 * 1000,
  player2StartMs: 5 * 60 * 1000,
};

function safeParse(json, fallback) {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function hasLocalStorage() {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

export function loadSettings() {
  if (!hasLocalStorage()) return { ...DEFAULT_SETTINGS };
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (!raw) return { ...DEFAULT_SETTINGS };
  return { ...DEFAULT_SETTINGS, ...safeParse(raw, {}) };
}

export function saveSettings(settings) {
  if (!hasLocalStorage()) return;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage full/unavailable (e.g. private browsing) — fail silently,
    // this must never block active timing.
  }
}

export function loadHistory() {
  if (!hasLocalStorage()) return [];
  const raw = localStorage.getItem(HISTORY_KEY);
  if (!raw) return [];
  const parsed = safeParse(raw, []);
  return Array.isArray(parsed) ? parsed : [];
}

export function appendHistory(record) {
  if (!hasLocalStorage()) return;
  try {
    const list = loadHistory();
    list.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...record });
    while (list.length > MAX_LOCAL_HISTORY) list.pop();
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  } catch {
    // Never let history persistence break active timing.
  }
}

export function clearHistory() {
  if (!hasLocalStorage()) return;
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    /* ignore */
  }
}
