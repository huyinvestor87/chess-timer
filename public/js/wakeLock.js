/**
 * Thin wrapper around the Screen Wake Lock API. Keeps the screen awake
 * while the timer is running (the whole point of an on-screen chess clock
 * is being glanced at continuously beside the board) and degrades to a
 * total no-op on browsers/devices without support — the timer itself never
 * depends on this succeeding.
 */
export class WakeLockManager {
  constructor() {
    this._sentinel = null;
    this._wanted = false;
    this._onVisibilityChange = this._onVisibilityChange.bind(this);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._onVisibilityChange);
    }
  }

  get isSupported() {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  }

  async enable() {
    this._wanted = true;
    if (!this.isSupported || this._sentinel) return;
    try {
      this._sentinel = await navigator.wakeLock.request('screen');
      this._sentinel.addEventListener('release', () => {
        this._sentinel = null;
      });
    } catch {
      // Permission denied, unsupported, or low battery — timer must still work.
      this._sentinel = null;
    }
  }

  async disable() {
    this._wanted = false;
    if (this._sentinel) {
      try {
        await this._sentinel.release();
      } catch {
        /* ignore */
      }
      this._sentinel = null;
    }
  }

  _onVisibilityChange() {
    // A wake lock is automatically released by the browser when the tab is
    // hidden; re-acquire it once the app is visible again, if it's still
    // wanted (i.e. the timer is still running).
    if (this._wanted && document.visibilityState === 'visible' && !this._sentinel) {
      this.enable();
    }
  }
}
