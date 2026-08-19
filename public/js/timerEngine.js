/**
 * ChessClockEngine — the pure timer state machine at the heart of the app.
 *
 * This module knows NOTHING about the DOM, Firebase, or chess. It is a
 * self-contained, timestamp-driven state machine that can be unit tested in
 * plain Node (see tests/timerEngine.test.js) completely independently of the
 * UI layer.
 *
 * Design principle: never derive "remaining time" by subtracting a fixed
 * tick amount on every interval. Instead every computation is anchored to
 * real timestamps (`now`), so the result is correct no matter how much wall
 * clock time actually passed between calls — whether that's 16ms (60fps),
 * 3 seconds (a dropped/backgrounded tab), or anything else. The UI layer
 * just needs to call getSnapshot(now) as often as it likes; calling it more
 * or less often never changes the *answer*, only how fresh the display is.
 *
 * States: SETUP -> READY -> RUNNING <-> PAUSED -> FINISHED
 *   SETUP    no configuration yet.
 *   READY    configured, clocks loaded with starting time, nothing running.
 *   RUNNING  exactly one player's clock is counting down.
 *   PAUSED   both clocks frozen; can resume back into RUNNING.
 *   FINISHED a player's time reached zero. Terminal until restart/new timer.
 */

export const TimerState = Object.freeze({
  SETUP: 'SETUP',
  READY: 'READY',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  FINISHED: 'FINISHED',
});

const MAX_HISTORY = 50;

function clonePlain(obj) {
  // Structured-clone-lite for our flat state object (no functions/dates
  // inside it), kept dependency-free so this module has zero imports.
  return JSON.parse(JSON.stringify(obj));
}

export class ChessClockEngine {
  /**
   * @param {object} [opts]
   * @param {() => number} [opts.now] injectable clock, defaults to Date.now.
   *        Date.now() (wall-clock time), not performance.now(), is used by
   *        default because it keeps advancing correctly across tab
   *        backgrounding/suspension the way a real chess clock's battery-
   *        driven crystal would — we WANT elapsed real-world time, not
   *        elapsed "active rendering" time.
   */
  constructor(opts = {}) {
    this._now = opts.now || (() => Date.now());
    this._reset();
  }

  _reset() {
    this.state = TimerState.SETUP;
    this.config = null;
    this.activePlayer = null; // 1 | 2 | null
    this.player1RemainingMs = 0;
    this.player2RemainingMs = 0;
    this.player1Moves = 0;
    this.player2Moves = 0;
    this.expiredPlayer = null; // 1 | 2 | null
    /** ms already elapsed in the *current* turn before the most recent resume. */
    this.turnElapsedBeforePauseMs = 0;
    /** timestamp the current turn's RUNNING span most recently began. */
    this.turnStartedAt = null;
    this.startedAt = null; // wall-clock time the match started (for history)
    this.endedAt = null;
    this._history = [];
  }

  /**
   * @param {object} config
   * @param {string} config.player1Name
   * @param {string} config.player2Name
   * @param {number} config.startMs      starting time per player, ms — used
   *        for both players unless overridden individually below.
   * @param {number} [config.player1StartMs]  overrides config.startMs for
   *        player 1 only. Together with player2StartMs this implements
   *        "chấp giờ" (time handicap): giving a weaker player more starting
   *        time than their opponent. Omit both to keep the normal
   *        symmetric behavior (both players get config.startMs).
   * @param {number} [config.player2StartMs]  overrides config.startMs for
   *        player 2 only.
   * @param {number} [config.incrementMs=0]  Fischer increment added after a
   *        completed move, ms — always the same for both players.
   * @param {number} [config.delayMs=0]  Bronstein/US-delay: this many ms of
   *        each turn elapse before the active player's clock starts counting
   *        down — always the same for both players.
   * @param {1|2} [config.firstPlayer=1]
   */
  configure(config) {
    const baseStartMs = Math.max(0, Math.round(config.startMs || 0));
    const player1StartMs = config.player1StartMs != null ? Math.max(0, Math.round(config.player1StartMs)) : baseStartMs;
    const player2StartMs = config.player2StartMs != null ? Math.max(0, Math.round(config.player2StartMs)) : baseStartMs;
    this.config = {
      player1Name: config.player1Name || 'Player 1',
      player2Name: config.player2Name || 'Player 2',
      player1StartMs,
      player2StartMs,
      incrementMs: Math.max(0, Math.round(config.incrementMs || 0)),
      delayMs: Math.max(0, Math.round(config.delayMs || 0)),
      firstPlayer: config.firstPlayer === 2 ? 2 : 1,
    };
    this.state = TimerState.READY;
    this.activePlayer = this.config.firstPlayer;
    this.player1RemainingMs = player1StartMs;
    this.player2RemainingMs = player2StartMs;
    this.player1Moves = 0;
    this.player2Moves = 0;
    this.expiredPlayer = null;
    this.turnElapsedBeforePauseMs = 0;
    this.turnStartedAt = null;
    this.startedAt = null;
    this.endedAt = null;
    this._history = [];
  }

  /** Begin the match: starts the first player's clock. */
  start(now = this._now()) {
    if (this.state !== TimerState.READY) return false;
    this.state = TimerState.RUNNING;
    this.turnStartedAt = now;
    this.turnElapsedBeforePauseMs = 0;
    this.startedAt = now;
    return true;
  }

  /**
   * How much of the given player's *current* turn has elapsed, decomposed
   * into delay-consumed and actually-decrementing time. Only meaningful for
   * the active player.
   */
  _turnElapsed(now) {
    const running = this.state === TimerState.RUNNING;
    const liveSpan = running && this.turnStartedAt != null ? Math.max(0, now - this.turnStartedAt) : 0;
    return this.turnElapsedBeforePauseMs + liveSpan;
  }

  /**
   * Computes remaining ms for both players at a given instant without
   * mutating state. Safe to call as often as desired (e.g. every animation
   * frame) purely for rendering.
   */
  getSnapshot(now = this._now()) {
    let p1 = this.player1RemainingMs;
    let p2 = this.player2RemainingMs;

    if ((this.state === TimerState.RUNNING || this.state === TimerState.PAUSED) && this.activePlayer) {
      const totalElapsed = this._turnElapsed(now);
      const decrementing = Math.max(0, totalElapsed - this.config.delayMs);
      if (this.activePlayer === 1) {
        p1 = Math.max(0, this.player1RemainingMs - decrementing);
      } else {
        p2 = Math.max(0, this.player2RemainingMs - decrementing);
      }
    }

    return {
      state: this.state,
      activePlayer: this.activePlayer,
      player1Name: this.config ? this.config.player1Name : '',
      player2Name: this.config ? this.config.player2Name : '',
      player1RemainingMs: p1,
      player2RemainingMs: p2,
      player1Moves: this.player1Moves,
      player2Moves: this.player2Moves,
      expiredPlayer: this.expiredPlayer,
      inDelay: this._isInDelay(now),
      canUndo: this._history.length > 0,
    };
  }

  _isInDelay(now) {
    if (this.state !== TimerState.RUNNING || !this.config || this.config.delayMs === 0) return false;
    return this._turnElapsed(now) < this.config.delayMs;
  }

  _snapshotForHistory() {
    return clonePlain({
      state: this.state,
      activePlayer: this.activePlayer,
      player1RemainingMs: this.player1RemainingMs,
      player2RemainingMs: this.player2RemainingMs,
      player1Moves: this.player1Moves,
      player2Moves: this.player2Moves,
      expiredPlayer: this.expiredPlayer,
      turnElapsedBeforePauseMs: this.turnElapsedBeforePauseMs,
      turnStartedAt: this.turnStartedAt,
    });
  }

  _pushHistory() {
    this._history.push(this._snapshotForHistory());
    if (this._history.length > MAX_HISTORY) this._history.shift();
  }

  /**
   * Registers a completed move: the given player pressed their side of the
   * clock. Only valid while RUNNING and only for the currently active
   * player — any other press (wrong player, not running, already finished)
   * is silently ignored, which is exactly what naturally guards against
   * rapid double-taps and stray presses on the inactive side.
   */
  press(player, now = this._now()) {
    if (this.state !== TimerState.RUNNING) return false;
    if (player !== this.activePlayer) return false;

    this._pushHistory();

    const totalElapsed = this._turnElapsed(now);
    const decrementing = Math.max(0, totalElapsed - this.config.delayMs);
    const baseRemaining = player === 1 ? this.player1RemainingMs : this.player2RemainingMs;
    let newRemaining = baseRemaining - decrementing;

    if (newRemaining <= 0) {
      this._setRemaining(player, 0);
      this._finish(player, now);
      return true;
    }

    newRemaining += this.config.incrementMs;
    this._setRemaining(player, newRemaining);

    if (player === 1) this.player1Moves += 1;
    else this.player2Moves += 1;

    this.activePlayer = player === 1 ? 2 : 1;
    this.turnStartedAt = now;
    this.turnElapsedBeforePauseMs = 0;
    return true;
  }

  _setRemaining(player, ms) {
    if (player === 1) this.player1RemainingMs = ms;
    else this.player2RemainingMs = ms;
  }

  _finish(expiredPlayer, now) {
    this.state = TimerState.FINISHED;
    this.expiredPlayer = expiredPlayer;
    this.endedAt = now;
  }

  /**
   * Passive check for time expiration, meant to be called on every render
   * tick. Because the underlying computation is timestamp-based, this will
   * correctly detect an expiration that "happened" while the tab was
   * backgrounded/throttled, even though no tick fired in real time — the
   * very next call after regaining focus will catch it using the true
   * elapsed wall-clock time.
   */
  checkExpiration(now = this._now()) {
    if (this.state !== TimerState.RUNNING || !this.activePlayer) return false;
    const snap = this.getSnapshot(now);
    const remaining = this.activePlayer === 1 ? snap.player1RemainingMs : snap.player2RemainingMs;
    if (remaining <= 0) {
      this._setRemaining(this.activePlayer, 0);
      this._finish(this.activePlayer, now);
      return true;
    }
    return false;
  }

  pause(now = this._now()) {
    if (this.state !== TimerState.RUNNING) return false;
    this.turnElapsedBeforePauseMs = this._turnElapsed(now);
    this.state = TimerState.PAUSED;
    return true;
  }

  resume(now = this._now()) {
    if (this.state !== TimerState.PAUSED) return false;
    this.state = TimerState.RUNNING;
    this.turnStartedAt = now;
    return true;
  }

  /**
   * Restores remaining times, move counts, active player and timer state to
   * how they were immediately before the last press(). The reverted
   * player's clock resumes ticking from `now` rather than from the old
   * (stale) turn-start timestamp: the real-world time spent making the
   * mistaken press and then reaching for Undo is not charged to anyone —
   * the display simply goes back to what it showed right before the
   * accidental press, same as a physical clock's takeback button.
   */
  undo(now = this._now()) {
    if (this._history.length === 0) return false;
    const prev = this._history.pop();
    Object.assign(this, prev);
    if (this.state === TimerState.RUNNING) {
      this.turnStartedAt = now;
      this.turnElapsedBeforePauseMs = 0;
    }
    return true;
  }

  /** Back to READY with the same configuration and full starting time. */
  restart() {
    if (!this.config) return false;
    const config = this.config;
    this.configure(config);
    return true;
  }

  /** Back to SETUP; caller must configure() again before start(). */
  newTimer() {
    this._reset();
  }

  /** Serializable summary suitable for local/Firestore history logging. */
  toHistoryRecord() {
    return {
      player1Name: this.config?.player1Name ?? '',
      player2Name: this.config?.player2Name ?? '',
      player1StartingTimeMs: this.config?.player1StartMs ?? 0,
      player2StartingTimeMs: this.config?.player2StartMs ?? 0,
      incrementMs: this.config?.incrementMs ?? 0,
      delayMs: this.config?.delayMs ?? 0,
      player1Moves: this.player1Moves,
      player2Moves: this.player2Moves,
      player1RemainingMs: this.player1RemainingMs,
      player2RemainingMs: this.player2RemainingMs,
      expiredPlayer: this.expiredPlayer,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
    };
  }
}
