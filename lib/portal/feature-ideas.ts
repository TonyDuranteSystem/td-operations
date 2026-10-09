/**
 * Feature ideas written by portal clients (dev job 1a23f5f1, Antonio 2026-10-08): "Do you have an idea? Share it
 * with us." Stored in portal_feature_ideas; staff read them in Portal Chats > "Idea request" (blue dot while unhandled).
 * Pure rules here (unit-tested); the routes are app/api/portal/feature-ideas (client) and
 * app/api/crm/admin-actions/feature-ideas (staff).
 */

export const IDEA_MIN = 5
export const IDEA_MAX = 1500

export type IdeaCheck = { ok: true; idea: string } | { ok: false; error: string }

/** Trim, collapse runaway blank lines, and enforce the length window. */
export function checkIdea(raw: unknown): IdeaCheck {
  if (typeof raw !== 'string') return { ok: false, error: 'Please write a few words about your idea.' }
  const idea = raw.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (idea.length < IDEA_MIN) return { ok: false, error: 'Please write a few words about your idea.' }
  if (idea.length > IDEA_MAX) return { ok: false, error: `Your idea is too long (maximum ${IDEA_MAX} characters). Please shorten it.` }
  return { ok: true, idea }
}

export interface IdeaRowLite {
  account_id: string | null
  contact_id: string | null
}

export interface IdeaCounts {
  by_account: Record<string, number>
  by_contact: Record<string, number>
  total: number
}

/**
 * Unhandled ideas per thread. A company thread counts the ideas written for that company; a person thread counts the
 * ideas that person wrote (across their companies). One idea can therefore light both dots; `total` counts each once.
 */
export function bucketIdeaCounts(ideas: IdeaRowLite[]): IdeaCounts {
  const by_account: Record<string, number> = {}
  const by_contact: Record<string, number> = {}
  for (const i of ideas) {
    if (i.account_id) by_account[i.account_id] = (by_account[i.account_id] ?? 0) + 1
    if (i.contact_id) by_contact[i.contact_id] = (by_contact[i.contact_id] ?? 0) + 1
  }
  return { by_account, by_contact, total: ideas.length }
}
