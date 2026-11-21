/**
 * "State refused the company name" panel in the Company Formation workspace (dev job bf9886a3, Antonio 2026-11-17).
 *
 * The action used to be a button in the Contact page's Wizard card; it moved here because the person who reads the state's refusal works
 * the formation job, not the Contact page. Pure rules, kept out of the page so they can be tested without a database:
 *   - WHEN the panel shows: a formation job that is still open, has its company (so the state has already accepted a name and the
 *     company exists) and is at a step from "Articles Received" onward. Before that the names step has its own "State refused this
 *     name" (nothing exists to cancel yet);
 *   - WHERE it sits among the step's panels: straight after the SS-4 correction panel when the step has one (both answer "something
 *     went wrong after the company was created"), otherwise just above the chat, and at the end when neither is there;
 *   - WHICH job took over from a cancelled formation (pickReplacementJob), for the "Replaced by" card on the cancelled job's page.
 */

import { isReplacementOf } from '@/lib/operations/start-new-company-rules'

export const ARTICLES_RECEIVED_STAGE = 'Articles Received'

export interface ShowPanelFacts {
  serviceType: string | null | undefined
  status: string | null | undefined
  accountId: string | null | undefined
  contactId: string | null | undefined
  /** pipeline_stages.stage_order of the job's current step (matched by NAME on the page — the job's own stage_order is often empty). */
  stageOrder: number | null | undefined
  /** pipeline_stages.stage_order of the "Articles Received" step. */
  articlesReceivedOrder: number | null | undefined
}

export function showStartNewCompanyPanel(f: ShowPanelFacts): boolean {
  if (f.serviceType !== 'Company Formation') return false
  if (f.status !== 'active') return false
  if (!f.accountId || !f.contactId) return false
  if (typeof f.stageOrder !== 'number' || typeof f.articlesReceivedOrder !== 'number') return false
  return f.stageOrder >= f.articlesReceivedOrder
}

/** The index in the step's panel list at which the panel is inserted (0..types.length). */
export function startNewCompanyPanelSlot(types: readonly string[]): number {
  const correction = types.indexOf('ss4_correction_panel')
  if (correction >= 0) return correction + 1
  const chat = types.indexOf('chat')
  if (chat >= 0) return chat
  return types.length
}

export interface ReplacementRow {
  id: string
  notes: string | null
  stage: string | null
  status: string | null
  created_at: string | null
}

/**
 * The job that took over from a cancelled formation: the newest job whose notes say "Replaces job <this id> …" (the line the press writes on
 * the new job). The cancelled job's own page shows a "Replaced by" card from it, so the way to the new job never depends on the page
 * staying as it was after the press (the dashboard refreshes pages by itself). Null when there is none.
 */
export function pickReplacementJob(rows: readonly ReplacementRow[] | null | undefined, oldJobId: string): ReplacementRow | null {
  const mine = (rows ?? []).filter((r) => r.id !== oldJobId && isReplacementOf(r.notes, oldJobId))
  if (mine.length === 0) return null
  return [...mine].sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))[0]
}
