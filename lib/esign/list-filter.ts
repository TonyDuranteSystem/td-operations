/**
 * E-Sign list — which documents show under each tab, and search.
 *
 * The list used to be the newest 50 envelopes with no paging, so an older
 * document still waiting on the client (or expired and needing a Reopen) fell
 * off the page entirely — Luca could not find a PrimeEdge tax return sitting at
 * row 71 (td-bug, 2026-09-24). The page now loads every envelope and opens on
 * "Needs action": anything that still wants a staff move.
 */

export type EsignListTab = "action" | "completed" | "all"

export const ESIGN_LIST_TABS: { key: EsignListTab; label: string }[] = [
  { key: "action", label: "Needs action" },
  { key: "completed", label: "Completed" },
  { key: "all", label: "All" },
]

/**
 * Still in someone's court: out with a signer, never sent, or lapsed without a
 * signature (Reopen or Void). Declined/voided are decisions already made.
 */
export const NEEDS_ACTION_STATUSES = ["draft", "sent", "in_progress", "expired"] as const

export interface EsignListRow {
  id: string
  document_name: string | null
  status: string | null
  company_name?: string | null
}

export function matchesTab(status: string | null | undefined, tab: EsignListTab): boolean {
  if (tab === "all") return true
  if (tab === "completed") return status === "completed"
  return (NEEDS_ACTION_STATUSES as readonly string[]).includes(status ?? "")
}

/** Case-insensitive match on the document name OR the company it belongs to. */
export function matchesSearch(row: EsignListRow, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [row.document_name, row.company_name].some(v => (v ?? "").toLowerCase().includes(q))
}

export function filterEsignRows<T extends EsignListRow>(rows: T[], tab: EsignListTab, query: string): T[] {
  return rows.filter(r => matchesTab(r.status, tab) && matchesSearch(r, query))
}

export function countByTab(rows: EsignListRow[]): Record<EsignListTab, number> {
  return {
    action: rows.filter(r => matchesTab(r.status, "action")).length,
    completed: rows.filter(r => matchesTab(r.status, "completed")).length,
    all: rows.length,
  }
}
