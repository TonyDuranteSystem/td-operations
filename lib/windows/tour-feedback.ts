/**
 * The "Something off, or an idea?" box of the windows tour (dev job f3f3e237) — the pure half: checking what
 * the browser sent, making it safe, and turning it into the one message that lands in the team channel.
 * Pure (no server-only imports) so it is unit-tested (R086); the route does the sending.
 *
 * Safety rules from the bug-hunter review (2026-10-06):
 *  - a feedback text must never start the AI worker or ping people: every "@" in what the person typed is
 *    defused (a zero-width space after it), so "@claude" / "@ai" / "@Luca" are just text. The only real
 *    mention is the one WE add, outside the person's words;
 *  - client identifiers are redacted in case someone pastes one (the channel has a wider readership than a
 *    client conversation);
 *  - bounded length, bounded fields, and nothing from the page itself (no path, no client data).
 */

import { redactIdentifiers } from '@/lib/team/redact-identifiers'
import { STEPS, TOUR_VERSION, type StepId } from '@/lib/windows/tour-steps'

export const FEEDBACK_CHANNEL_SLUG = 'td-windows-feedback'
export const FEEDBACK_MIN = 3
export const FEEDBACK_MAX = 1500
/** How many notes one person may send per hour before we ask them to wait (stops a stuck button / a script). */
export const FEEDBACK_PER_HOUR = 20

const STEP_IDS = new Set<string>([...STEPS.map(s => s.id), 'none'])
const STATES = new Set(['waiting', 'done', 'skipped', 'auto', 'blocked', 'read'])

export interface FeedbackInput {
  text: string
  /** The step the note came from, or 'none' when it was sent outside the tour (from the launcher menu). */
  step: StepId | 'none'
  state: 'waiting' | 'done' | 'skipped' | 'auto' | 'blocked' | 'read'
  platform: 'mac' | 'other'
  viewportWidth: number
  windowCount: number
  tourVersion: number
}

export type FeedbackCheck = { ok: true; value: FeedbackInput } | { ok: false; error: string }

/** Explicit narrowing: the project's TypeScript is not strict, so `!r.ok` alone does not narrow. */
export function isFeedbackRejected(c: FeedbackCheck): c is Extract<FeedbackCheck, { ok: false }> {
  return c.ok === false
}

function intIn(v: unknown, min: number, max: number): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? Math.round(v) : null
}

/** Check the body the browser sent. Anything unexpected is refused with a plain reason. */
export function validateFeedback(body: unknown): FeedbackCheck {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'Nothing to send.' }
  const b = body as Record<string, unknown>
  const text = typeof b.text === 'string' ? b.text.trim() : ''
  if (text.length < FEEDBACK_MIN) return { ok: false, error: 'Please write a few words so we can understand.' }
  if (text.length > FEEDBACK_MAX) return { ok: false, error: `That is too long (the limit is ${FEEDBACK_MAX} characters). Please shorten it.` }
  if (typeof b.step !== 'string' || !STEP_IDS.has(b.step)) return { ok: false, error: 'Unknown tour step.' }
  if (typeof b.state !== 'string' || !STATES.has(b.state)) return { ok: false, error: 'Unknown step state.' }
  if (b.platform !== 'mac' && b.platform !== 'other') return { ok: false, error: 'Unknown platform.' }
  const viewportWidth = intIn(b.viewportWidth, 0, 20000)
  const windowCount = intIn(b.windowCount, 0, 50)
  const tourVersion = intIn(b.tourVersion, 0, 1000)
  if (viewportWidth === null || windowCount === null || tourVersion === null) return { ok: false, error: 'Bad context numbers.' }
  return {
    ok: true,
    value: {
      text,
      step: b.step as StepId | 'none',
      state: b.state as FeedbackInput['state'],
      platform: b.platform,
      viewportWidth,
      windowCount,
      tourVersion,
    },
  }
}

const ZWSP = '​'

/** Make a person's words safe to put in a channel: no mentions, no worker triggers, no client identifiers. */
export function defuse(text: string): string {
  return redactIdentifiers(text).replace(/@/g, `@${ZWSP}`)
}

/** The one message posted to the channel. `name` is the person's display name (also defused). */
export function formatFeedbackMessage(input: FeedbackInput, name: string): string {
  const index = STEPS.findIndex(s => s.id === input.step)
  const step = STEPS[index]
  const where = step ? `Step ${index + 1} of ${STEPS.length} — ${step.title} (${input.state})` : 'Sent from the menu (not during the tour)'
  const context = [
    input.platform === 'mac' ? 'Mac' : 'Windows/other',
    `screen ${input.viewportWidth}px wide`,
    `${input.windowCount} window${input.windowCount === 1 ? '' : 's'} open`,
    `tour v${input.tourVersion}`,
  ].join(' · ')
  return [
    `💬 Windows tour feedback from ${defuse(name)}`,
    `${where} · ${context}`,
    '',
    defuse(input.text),
    '',
    '@Antonio',
  ].join('\n')
}

/** Is this feedback from the CURRENT version of the tour? (Older notes may describe steps that no longer exist.) */
export function isCurrentVersion(v: number): boolean {
  return v === TOUR_VERSION
}
