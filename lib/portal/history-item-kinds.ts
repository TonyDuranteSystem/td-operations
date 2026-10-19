/** The kinds of company history staff can open one by one. Dependency-free (client-safe). */
export const HISTORY_ITEM_KINDS = ["invoice", "expense", "payment", "notification", "message", "correspondence"] as const
export type HistoryItemKind = (typeof HISTORY_ITEM_KINDS)[number]

export function isHistoryItemKind(v: unknown): v is HistoryItemKind {
  return typeof v === "string" && (HISTORY_ITEM_KINDS as readonly string[]).includes(v)
}

