/**
 * The rules behind "Connection lost — reconnecting…" and "catch up when the network is back", with no browser in them so they
 * are tested in plain node.
 *
 * Why (Antonio 2026-10-23): after switching from the LAN cable to WiFi an upload failed and the CRM page only recovered after a
 * manual refresh. The existing wake signal (`use-wake-signal.ts`) already refreshes the live screens, but only when the app was
 * away for 20 s or more — a network drop shorter than that, or one the browser never reports as "away", left the screen stale.
 *
 * Rules:
 *  - the banner is shown only after the connection has been down for `delayMs` (a blink must not flicker a banner);
 *  - ANY return from offline fires `reconnected` once — even after a short drop, because requests made during it have failed;
 *  - two "offline" events in a row count once; an "online" with no earlier "offline" does nothing.
 */
export interface ConnectionCallbacks {
  showOffline: () => void
  hideOffline: () => void
  reconnected: () => void
}

export interface ConnectionTimers {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

export const OFFLINE_BANNER_DELAY_MS = 3000

export class ConnectionTracker {
  private offline = false
  private bannerShown = false
  private timer: unknown = null

  constructor(
    private readonly cb: ConnectionCallbacks,
    private readonly delayMs: number = OFFLINE_BANNER_DELAY_MS,
    private readonly timers: ConnectionTimers = {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    },
  ) {}

  goOffline(): void {
    if (this.offline) return
    this.offline = true
    this.timer = this.timers.set(() => {
      this.timer = null
      if (!this.offline) return
      this.bannerShown = true
      this.cb.showOffline()
    }, this.delayMs)
  }

  goOnline(): void {
    if (!this.offline) return
    this.offline = false
    if (this.timer !== null) { this.timers.clear(this.timer); this.timer = null }
    if (this.bannerShown) { this.bannerShown = false; this.cb.hideOffline() }
    this.cb.reconnected()
  }

  dispose(): void {
    if (this.timer !== null) { this.timers.clear(this.timer); this.timer = null }
  }
}
