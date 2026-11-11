/**
 * The shapes the "Invoices to raise" list hands to the Calendar (dev job ae3c19db). Client-safe: types only, no database, so the Calendar's
 * page body (which is pinned to import nothing that reads data) can name them.
 */

import type { PartDueReason } from "@/lib/plan-invoices/classify"

export interface InvoiceToRaiseRow {
  /** `token:seq` — stable key for the row. */
  key: string
  offerToken: string
  seq: number
  totalParts: number
  amount: number
  currency: string
  /** The offer's client name as written on the offer. */
  clientName: string
  /** Who will be billed (the offer's "Invoice to"): name, email and the CRM page to open. Null parts = could not be resolved. */
  payerName: string | null
  payerEmail: string | null
  payerHref: string | null
  /** What the invoice is for ("Company Formation + Company Closure"). */
  serviceLabel: string
  /** "Part 2 of 2". */
  partText: string
  due: boolean
  reason: PartDueReason | null
  /** Plain words for staff — why it is due, or what it waits for. */
  text: string
  stepNotFound: boolean
}

export interface InvoicesToRaise {
  rows: InvoiceToRaiseRow[]
  dueCount: number
}

