/** Kinds of older item staff can open one by one to people who joined a company later (dev job d14e823f, slice 3b). Client-safe. */
import { HISTORY_ITEM_KINDS, type HistoryItemKind } from "@/lib/portal/history-item-kinds"

export type OpenableKind = HistoryItemKind | "document"

export const OPENABLE_KIND_LABELS: Record<OpenableKind, string> = {
  document: "Documents",
  invoice: "Client sales invoices",
  expense: "Expenses",
  payment: "Payments to Tony Durante",
  correspondence: "Received letters",
  message: "Chat messages",
  notification: "Notices",
}

export interface OlderItem {
  id: string
  label: string
  sub: string
  date: string
  opened: boolean
}

export function isOpenableKind(v: unknown): v is OpenableKind {
  return v === "document" || (typeof v === "string" && (HISTORY_ITEM_KINDS as readonly string[]).includes(v))
}
