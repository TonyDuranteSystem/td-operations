/**
 * The timing rules for holding a message before it sends — pure, no React.
 *
 * Antonio, 2026-07-19: "sometimes maybe I can make a mistake by clicking Return too
 * early, and I want to stop and maybe reformulate the question."
 *
 * WHY A HOLD AND NOT A STOP-WHILE-THINKING. Aborting a request that is already running
 * only stops the UI waiting for it — the server carries on, and if the message was
 * "send it" the client may already have been emailed. A stop button that cannot stop
 * anything is the exact class of false capability this codebase has spent the day
 * removing. So nothing reaches the server until the hold expires: cancelling during the
 * hold is a guaranteed cancel, because nothing has started.
 *
 * THE COST, STATED PLAINLY: every message the staff member is NOT trying to catch is a
 * few seconds slower. That is why a second Enter fires immediately — when you are sure,
 * there is no wait — and why the hold is short. The worker takes far longer than this
 * to answer, so it is small against the turn.
 *
 * Lives apart from the hook so the rules are testable without a DOM: the property that
 * matters (a cancelled message is NEVER sent, even after its deadline passes) is a
 * timing rule, not a rendering one.
 */

/** How long a message waits before it actually goes. */
export const HOLD_MS = 4000

export interface HoldCallbacks<T> {
  /** Fire the message for real. */
  send: (payload: T) => void
  /** Told whenever the visible state changes, so the UI can re-render. */
  onChange?: (state: { armed: boolean; secondsLeft: number }) => void
}

export class HoldController<T> {
  private timer: ReturnType<typeof setTimeout> | null = null
  private ticker: ReturnType<typeof setInterval> | null = null
  private payload: T | null = null
  private hasPayload = false
  private _armed = false
  private _secondsLeft: number

  constructor(
    private readonly cb: HoldCallbacks<T>,
    private readonly holdMs: number = HOLD_MS,
  ) {
    this._secondsLeft = Math.ceil(holdMs / 1000)
  }

  get armed(): boolean {
    return this._armed
  }

  get secondsLeft(): number {
    return this._secondsLeft
  }

  /**
   * Start the hold — or, if already holding, send NOW.
   *
   * The second call carries the newest payload deliberately: the staff member may have
   * kept typing before deciding they were sure.
   */
  arm(payload: T): void {
    this.payload = payload
    this.hasPayload = true
    if (this._armed) {
      this.fire()
      return
    }
    this._armed = true
    this._secondsLeft = Math.ceil(this.holdMs / 1000)
    this.emit()

    const startedAt = Date.now()
    this.ticker = setInterval(() => {
      const remaining = this.holdMs - (Date.now() - startedAt)
      // Never show 0 — it reads as "gone" while the message is still catchable.
      const next = Math.max(1, Math.ceil(remaining / 1000))
      if (next !== this._secondsLeft) {
        this._secondsLeft = next
        this.emit()
      }
    }, 100)
    this.timer = setTimeout(() => this.fire(), this.holdMs)
  }

  /** Cancel without sending. After this the message can never go. */
  cancel(): void {
    this.clearTimers()
    this.payload = null
    this.hasPayload = false
    this.reset()
  }

  /** Drop everything — for unmount. A closed panel must not fire a held message. */
  dispose(): void {
    this.clearTimers()
    this.payload = null
    this.hasPayload = false
    this._armed = false
  }

  private fire(): void {
    this.clearTimers()
    const payload = this.payload
    const had = this.hasPayload
    this.payload = null
    this.hasPayload = false
    this.reset()
    // The guard is for the cancel-vs-expiry race: a cancelled message must never be
    // sent by a timer that was already in flight.
    if (had) this.cb.send(payload as T)
  }

  private reset(): void {
    this._armed = false
    this._secondsLeft = Math.ceil(this.holdMs / 1000)
    this.emit()
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer)
    if (this.ticker) clearInterval(this.ticker)
    this.timer = null
    this.ticker = null
  }

  private emit(): void {
    this.cb.onChange?.({ armed: this._armed, secondsLeft: this._secondsLeft })
  }
}
