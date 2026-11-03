/**
 * Recording guard (Antonio, 3 Nov 2026 audit): leaving a chat while a voice note is being recorded threw the recording away without a word.
 * The screen now asks first. This file holds the decision; `talk-app.tsx` shows the question.
 */

/** What the composer lets the screen do with a recording in progress. */
export interface RecordingControl {
  /** Stop and send the voice note to the chat it is being recorded in. */
  send(): void
  /** Throw the recording away. */
  discard(): void
}

/** How a voice note ended, as the composer reports it. */
export type VoiceOutcome = 'sent' | 'failed' | 'cancelled'

/** True when leaving (to another chat, the list, the search or the new-group screen) would lose a recording in progress. */
export function leavingLosesRecording(isRecording: boolean): boolean {
  return isRecording === true
}

/** How long the screen waits for a "Send it" to finish before it moves on anyway. */
export const SEND_BEFORE_LEAVING_TIMEOUT_MS = 10_000

/** After "Send it": does the person stay in the chat? Yes unless the note was really kept (a failed save would lose the recording; a thrown-away note is not "Send it"). */
export function stayAfterVoice(outcome: VoiceOutcome): boolean {
  return outcome === 'failed'
}
