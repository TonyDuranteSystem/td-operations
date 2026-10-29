/**
 * The short summary shown when the mouse rests on an invoice number in the Bank Feed — so a person
 * can tell which invoice it is, and WHOSE it is, without opening it (Antonio, 2026-10-29: "when I
 * pass with the mouse on the invoice number I want a summary of the invoice without opening it.
 * now I have the description but I can't see the client name, so it's confused").
 *
 * The Bank Feed shows invoices from several sources that carry different fields (the "who paid"
 * list, the page's open-invoice list, the invoice a matched transaction points at). Each source is
 * turned into one common shape first, so every number shows the same summary.
 *
 * Pure: no database, no clock.
 */
import { formatCalendarDate, formatDetailAmount } from "@/lib/finance/contested-invoice-detail"
import { isPaidInvoice } from "@/lib/finance/invoice-matchability"

export interface InvoiceSummaryInput {
  invoice_number: string | null
  /** The client: the company, or the person when the invoice has no company. */
  party: string | null
  description: string | null
  installment: string | null
  total: number | null
  /** What is still owed (unpaid invoices). */
  balance: number | null
  currency: string | null
  paid: boolean
  paid_date: string | null
  /** The invoice's own status word when it is not Paid (Draft, Sent, Overdue, Partial, ...). */
  status_label: string | null
  /** Another bank transaction is already linked to this (paid) invoice. */
  claimed_by_other?: boolean
}

export interface InvoiceSummaryLine {
  label: string
  value: string
}

export interface InvoiceSummary {
  title: string
  lines: InvoiceSummaryLine[]
}

const num = (v: number | string | null | undefined): number | null => {
  if (v == null || v === "") return null
  const n = typeof v === "string" ? parseFloat(v) : v
  return Number.isFinite(n) ? n : null
}

export function summarizeInvoice(input: InvoiceSummaryInput): InvoiceSummary {
  const lines: InvoiceSummaryLine[] = []

  lines.push({ label: "Client", value: input.party?.trim() || "no client on this invoice" })

  const what = [input.description?.trim(), input.installment?.trim()].filter((s): s is string => !!s).join(" — ")
  if (what) lines.push({ label: "For", value: what })

  const total = formatDetailAmount(input.total, input.currency)
  if (total) lines.push({ label: "Amount", value: total })

  if (input.paid) {
    const on = formatCalendarDate(input.paid_date)
    lines.push({ label: "Status", value: on ? `Paid ${on}` : "Paid" })
  } else {
    const owed = formatDetailAmount(input.balance, input.currency)
    const word = input.status_label?.trim() || "Not paid yet"
    lines.push({ label: "Status", value: owed ? `${word} — ${owed} still owed` : word })
  }

  if (input.claimed_by_other) {
    lines.push({ label: "Note", value: "Another bank payment is already linked to this invoice" })
  }

  return { title: input.invoice_number?.trim() || "No invoice number", lines }
}

/** From an invoice of the "who paid" list (lib/finance/payer-invoices.ts `PayerInvoice`). */
export function summaryInputFromPayerInvoice(inv: {
  invoice_number: string | null
  party: string
  description: string | null
  installment: string | null
  total: number | null
  balance: number | null
  currency: string | null
  paid: boolean
  paid_date: string | null
  status_label: string | null
  claimed_by_other: boolean
}): InvoiceSummaryInput {
  return {
    invoice_number: inv.invoice_number,
    party: inv.party === "—" ? null : inv.party,
    description: inv.description,
    installment: inv.installment,
    total: inv.total,
    balance: inv.balance,
    currency: inv.currency,
    paid: inv.paid,
    paid_date: inv.paid_date,
    status_label: inv.status_label,
    claimed_by_other: inv.claimed_by_other,
  }
}

/** From an invoice the Finance page already holds (`OpenInvoice`) — unpaid, or a paid one from the paid search. */
export function summaryInputFromOpenInvoice(
  inv: {
    invoice_number: string | null
    description: string | null
    total: number | string | null
    amount: number | string | null
    amount_due: number | string | null
    amount_currency: string | null
    invoice_status: string | null
    status?: string | null
  },
  party: string,
): InvoiceSummaryInput {
  const total = num(inv.total) ?? num(inv.amount)
  const paid = isPaidInvoice({ invoice_status: inv.invoice_status, status: inv.status ?? null })
  // The same figure the lists use as "what this payment would be applied to".
  const balance = paid ? null : inv.invoice_status === "Partial" ? (num(inv.amount_due) ?? total) : total
  return {
    invoice_number: inv.invoice_number,
    party: party === "—" ? null : party,
    description: inv.description,
    installment: null,
    total,
    balance,
    currency: inv.amount_currency,
    paid,
    paid_date: null,
    status_label: paid ? null : inv.invoice_status,
  }
}

/** From the invoice a matched transaction points at (`td_bank_feeds.payments` embed). */
export function summaryInputFromMatchedPayment(p: {
  invoice_number: string | null
  description: string | null
  total: number | null
  amount_paid: number | null
  invoice_status: string | null
  accounts: { company_name: string } | null
}, currency: string | null): InvoiceSummaryInput {
  const total = num(p.total)
  const paid = p.invoice_status === "Paid"
  return {
    invoice_number: p.invoice_number,
    party: p.accounts?.company_name?.trim() || null,
    description: p.description,
    installment: null,
    total,
    balance: paid || total == null ? null : Math.max(total - (num(p.amount_paid) ?? 0), 0),
    currency,
    paid,
    paid_date: null,
    status_label: paid ? null : p.invoice_status,
  }
}
