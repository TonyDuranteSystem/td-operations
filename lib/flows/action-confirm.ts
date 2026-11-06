/**
 * "Ask before you act" for a workspace button (Company Closure, Antonio 2026-11-06: finishing a closure that closes one of our companies
 * must ask first — "confirmation pop-up first"). Pure, so the button and the tests use the same rule.
 *
 * An `action_buttons` entry can carry `confirm` (always asked) and/or `confirmCompany` (asked INSTEAD, when the job belongs to a company of
 * ours — the sentence that says what closes). No sentence = the button acts at once, exactly as every existing button does.
 */
import type { StageAction } from '@/lib/flows/stage-layout'

/** The sentence a button asks before acting, or null when it should act at once. */
export function actionConfirmText(action: StageAction, hasCompany: boolean): string | null {
  if (typeof action === 'string') return null
  const text = hasCompany && action.confirmCompany ? action.confirmCompany : action.confirm
  return typeof text === 'string' && text.trim() ? text : null
}
