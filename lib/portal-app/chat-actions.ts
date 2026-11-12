/**
 * Client iPhone app, Chat: a TAP on a message opens its small action row (Reply, Pin, Mark unread, React) instead of three icon buttons
 * sitting beside every message (dev job 056a70d0; docs/systems/client-app.md). Pure, so the rule is tested without a browser.
 *
 * A tap must NOT open the row when it was really meant for something inside the message: a link, a button (a file, the voice note's play
 * button, a reaction), a picture (opens full size) or a text box, or when the person is selecting words (a long press selects text on iPhone).
 */
export const OWN_TAP_SELECTOR = 'a, button, audio, video, input, textarea, select, img, [role="button"], [data-own-tap]'

export function tapOpensActions(
  target: { closest?: (selector: string) => unknown } | null | undefined,
  selectedText: string | null | undefined,
): boolean {
  if (typeof selectedText === 'string' && selectedText.trim() !== '') return false
  if (!target || typeof target.closest !== 'function') return false
  return !target.closest(OWN_TAP_SELECTOR)
}

/** Which message has its action row open after a tap on `tapped`: the same message again closes it, another one moves it. */
export function nextActionsFor(current: string | null, tapped: string): string | null {
  return current === tapped ? null : tapped
}
