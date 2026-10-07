/**
 * Should a finished AI answer (polish or draft) be applied to the WhatsApp composer?
 *
 * The answer arrives seconds after the click. In that time the staff member may have switched chat, clicked again,
 * kept typing, or a Worker draft may have been merged into the box. Applying a stale answer would overwrite what
 * they typed or put one chat's words into another (Antonio, 2026-10-07: the sparkle must never change what he wrote
 * behind his back). Pure so it is unit-tested; the composer reads the CURRENT values through refs, never closures.
 */
export type AiApplyDecision =
  | { apply: true }
  | { apply: false; reason: "other_chat" | "superseded" | "box_changed" | "no_change"; notice: string | null }

export function decideAiApply(input: {
  mode: "polish" | "draft"
  /** The text in the box when the click happened. */
  sentText: string
  /** The text in the box NOW. */
  currentText: string
  requestGroupId: string
  currentGroupId: string
  requestId: number
  currentRequestId: number
  /** Polish only: false when the AI's version equals what he typed. */
  changed?: boolean
}): AiApplyDecision {
  if (input.currentGroupId !== input.requestGroupId) return { apply: false, reason: "other_chat", notice: null }
  if (input.currentRequestId !== input.requestId) return { apply: false, reason: "superseded", notice: null }
  if (input.currentText !== input.sentText) {
    return { apply: false, reason: "box_changed", notice: "You changed the text while the AI was working, so its version was not applied." }
  }
  if (input.mode === "polish" && input.changed === false) {
    return { apply: false, reason: "no_change", notice: "Your text already reads well — the AI changed nothing." }
  }
  return { apply: true }
}
