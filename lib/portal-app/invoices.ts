/**
 * Client iPhone app — the Invoices screens (pure rules; dev job 056a70d0, Step 3c).
 *
 * Inside the app `/portal/invoices` opens on a short LIST of areas (Setup, Customers, Sales, Vendors, Expenses) instead of the website's
 * row of tabs, and the TD Billing entry opens a screen of its own: the invoices Tony Durante LLC sent, with where to pay them. Both are
 * only a different way of showing what the page already works out; the numbers, the history start date and who may see which area stay
 * the website's own rules (`lib/portal/invoice-hub.ts`). Nothing here reads the database.
 */
import { format, parseISO } from 'date-fns'
import type { InvoiceTabId } from '@/lib/portal/invoice-hub'
import type { ChecklistRule } from '@/lib/portal/guides/guides'
import type { MoneyByCurrency } from '@/lib/portal/invoice-totals'

/** The address word for the TD Billing screen: `/portal/invoices?tab=billing`. Not a tab of the website (the website never reads it). */
export const APP_BILLING_TAB = 'billing'

export type AppInvoicesScreen = 'areas' | 'billing' | 'tab'

/** The Invoices list address, keeping the company a person is managing (`?accountId=<id>`, the website's own address word). */
export function invoicesRootHref(managedAccountId?: string | null): string {
  return managedAccountId ? `/portal/invoices?accountId=${encodeURIComponent(managedAccountId)}` : '/portal/invoices'
}

/** `&accountId=<id>` for a person managing a client's company (the website's own address word), so going between the list and an area keeps the company. */
export function accountQuery(managedAccountId?: string | null): string {
  return managedAccountId ? `&accountId=${encodeURIComponent(managedAccountId)}` : ''
}

/**
 * Which Invoices screen the app shows. No tab in the address = the list; `billing` = TD Billing; any other tab = that area exactly as the
 * website draws it. The link in the "payment received" email (`view=paid`) always means the Expenses area, as on the website.
 */
export function appInvoicesScreen(params: { tab?: string; view?: string }): AppInvoicesScreen {
  if (params.view === 'paid') return 'tab'
  if (params.tab === APP_BILLING_TAB) return 'billing'
  if (!params.tab) return 'areas'
  return 'tab'
}

export interface AppArea {
  id: InvoiceTabId
  labelKey: string
  href: string
  /** The number shown on the row (not for Setup). */
  count: number
  /** Setup only: how many required steps are still open (an amber badge instead of a number). */
  badge: number
}

/** The list rows, in the website's tab order, only for the areas this person may open. */
export function appInvoiceAreas(
  tabs: ReadonlyArray<{ id: InvoiceTabId; labelKey: string }>,
  counts: { customers: number; sales: number; vendors: number; expenses: number },
  setupMissing: number,
  managedAccountId?: string | null,
): AppArea[] {
  return tabs.map(tab => ({
    id: tab.id,
    labelKey: tab.labelKey,
    href: `/portal/invoices?tab=${tab.id}${accountQuery(managedAccountId)}`,
    count: tab.id === 'customers' ? counts.customers
      : tab.id === 'sales' ? counts.sales
      : tab.id === 'vendors' ? counts.vendors
      : tab.id === 'expenses' ? counts.expenses
      : 0,
    badge: tab.id === 'setup' ? Math.max(0, setupMissing) : 0,
  }))
}

/** Required steps first, then the optional ones, each group in the order given (the website lists the optional logo first; the app does not). */
export function requiredFirst<T extends { required: boolean }>(steps: readonly T[]): T[] {
  return [...steps.filter(s => s.required), ...steps.filter(s => !s.required)]
}

/**
 * Where a set-up step leads. The rule names are the website's (`CHECKLIST_RULES`): adding how customers pay and adding the logo are both
 * done on Setup, the first customer on Customers. A step whose area this person cannot open is not a link. A person managing a client's
 * company keeps that company (`&accountId=`), the website's own address word.
 */
export function checklistStepTarget(rule: ChecklistRule | undefined, visible: ReadonlyArray<InvoiceTabId>, managedAccountId?: string | null): string | null {
  const tab: InvoiceTabId | null = rule === 'customer' ? 'customers' : rule === 'payment' || rule === 'logo' ? 'setup' : null
  return tab && visible.includes(tab) ? `/portal/invoices?tab=${tab}${accountQuery(managedAccountId)}` : null
}

/** The ids of the logo and bank cards on the Setup area, so a step can jump down to them (they are on the same screen as the steps). */
export const SETUP_LOGO_ANCHOR = 'invoice-setup-logo'
export const SETUP_BANK_ANCHOR = 'invoice-setup-bank'

/**
 * Where a step on the SETUP screen itself leads (the steps are drawn there too, as a plain list on the website). The first customer is
 * another area (a page address); the logo and how customers pay are cards on this same screen (a `#` jump, nothing to load). The logo card
 * exists only for a person allowed to change it, so without that there is no jump for the logo step.
 */
export function setupScreenStepTarget(
  rule: ChecklistRule | undefined,
  visible: ReadonlyArray<InvoiceTabId>,
  opts: { canEditLogo: boolean; managedAccountId?: string | null },
): string | null {
  if (rule === 'logo') return opts.canEditLogo ? `#${SETUP_LOGO_ANCHOR}` : null
  if (rule === 'payment') return `#${SETUP_BANK_ANCHOR}`
  return checklistStepTarget(rule, visible, opts.managedAccountId)
}

// ── The Invoices home, the Sales and Expenses lists (dev job 056a70d0, "invoices in gray") ─────────────────────────────────────────────

/** How many of the newest invoices the Invoices home lists before "See all". */
export const LATEST_INVOICES = 3

export type InvoicesHomeMode = 'steps' | 'summary' | 'links'

/**
 * What the Invoices home draws at the top.
 *   steps   = a client whose required set-up steps are not all done: the "before your first invoice" card leads (most companies today);
 *   summary = everything needed is in and the person may see Sales: the graphite "owed to you" card, the latest invoices;
 *   links   = a person with no Sales area (no company, only personal expenses): just the list of areas.
 * The decision uses the page's existing required-steps count (`setupMissing`), never "has customers" or "has invoices".
 */
export function invoicesHomeMode(input: { isClientHub: boolean; setupMissing: number; canSeeSales: boolean }): InvoicesHomeMode {
  if (input.isClientHub && input.setupMissing > 0) return 'steps'
  return input.canSeeSales ? 'summary' : 'links'
}

/** "$150.00" / "€1,256.00" lines, one per currency actually present (dollars first); a zero in `zeroCurrency` when there is nothing. */
export function moneyLines(map: MoneyByCurrency, zeroCurrency: 'USD' | 'EUR' = 'USD'): string[] {
  const lines = (['USD', 'EUR'] as const)
    .filter(c => map[c] !== undefined && map[c] !== 0)
    .map(c => `${c === 'EUR' ? '\u20AC' : '$'}${map[c].toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
  return lines.length > 0 ? lines : [`${zeroCurrency === 'EUR' ? '\u20AC' : '$'}0.00`]
}

/** The colour family of a status pill: paid green, still owed amber, overdue red, draft/cancelled gray. */
export type StatusTone = 'ok' | 'warn' | 'bad' | 'draft'

export function salesStatusTone(status: string): StatusTone {
  if (status === 'Paid') return 'ok'
  if (status === 'Sent' || status === 'Partial') return 'warn'
  if (status === 'Overdue') return 'bad'
  return 'draft'
}

export function expenseStatusTone(status: string): StatusTone {
  if (status === 'Paid') return 'ok'
  if (status === 'Pending') return 'warn'
  if (status === 'Overdue') return 'bad'
  return 'draft'
}

/** "October 2026" for a date (an ISO date or timestamp); empty for none or an unreadable one. */
export function monthHeading(iso: string | null | undefined): string {
  if (!iso) return ''
  try { return format(parseISO(iso), 'MMMM yyyy') } catch { return '' }
}

/** Groups rows (already newest first) under month headings, keeping their order; a row with no readable date joins the group before it. */
export function groupByMonth<T extends { issue_date: string | null }>(rows: readonly T[]): { label: string; rows: T[] }[] {
  const groups: { label: string; rows: T[] }[] = []
  for (const row of rows) {
    const label = monthHeading(row.issue_date)
    const last = groups[groups.length - 1]
    if (last && (label === '' || label === last.label)) last.rows.push(row)
    else groups.push({ label, rows: [row] })
  }
  return groups
}

// ── TD Billing ──────────────────────────────────────────────────────────────────

export interface BillingExpense {
  id: string
  /** "Personal" or the company's name; shown on a row only when the list mixes more than one. */
  scope_label?: string | null
  /** Money already received on it (a part payment). */
  amount_paid?: number | null
  invoice_number: string | null
  internal_ref: string | null
  vendor_name: string
  description: string | null
  currency: string
  total: number
  amount_due?: number | null
  due_date: string | null
  paid_date: string | null
  status: string
  source: string
  td_payment_id: string | null
}

/** The invoices from Tony Durante LLC, in the order the page already sorted them (newest first). */
export function tdInvoicesOf<T extends { source: string }>(expenses: readonly T[]): T[] {
  return expenses.filter(e => e.source === 'td_invoice')
}

export type BillingRowKind = 'credit' | 'cancelled' | 'paid' | 'overdue' | 'due'

export interface BillingRowState {
  kind: BillingRowKind
  /** The date written on the tag (due date, or the day it was paid); null when the invoice has none. */
  date: string | null
  /** The Pay button is offered: a Tony Durante invoice with a payment behind it, still Pending or Overdue, not a credit note (the website's rule plus that last guard). */
  canPay: boolean
}

export function billingRowState(e: Pick<BillingExpense, 'status' | 'total' | 'due_date' | 'paid_date' | 'td_payment_id' | 'source'>): BillingRowState {
  const open = e.status === 'Pending' || e.status === 'Overdue'
  // A credit note is money owed TO the client, never a bill: no Pay on a negative total (the website's list would offer it by status alone).
  const canPay = e.source === 'td_invoice' && !!e.td_payment_id && open && Number(e.total) >= 0
  if (Number(e.total) < 0) return { kind: 'credit', date: null, canPay }
  if (e.status === 'Cancelled') return { kind: 'cancelled', date: null, canPay }
  if (e.status === 'Paid') return { kind: 'paid', date: e.paid_date, canPay }
  return { kind: e.status === 'Overdue' ? 'overdue' : 'due', date: e.due_date, canPay }
}

/**
 * The amount written on a row. An open invoice shows what is still to pay: the balance on file, or, when the balance is missing/zero but
 * money was already received, the invoice total minus that money (what the Pay pop-up asks the card for); else the whole total. A paid,
 * cancelled or credit row shows the invoice's own total, so a paid invoice does not read $0.00. A zero balance on an open invoice with
 * nothing received is a bookkeeping gap, not "nothing to pay": it shows the total rather than $0.00 next to a Pay button.
 */
export function billingRowAmount(e: Pick<BillingExpense, 'total' | 'amount_due' | 'status'> & { amount_paid?: number | null }): number {
  const open = e.status === 'Pending' || e.status === 'Overdue'
  const total = Number(e.total)
  if (!open) return total
  if (Number(e.amount_due) > 0) return Number(e.amount_due)
  const paid = Number(e.amount_paid)
  if (paid > 0 && total > paid) return Math.round((total - paid) * 100) / 100
  return total
}

export type MoneyMap = Record<string, number>

/**
 * The three boxes at the top of TD Billing, per currency (dollars and euros are never added together).
 *   Total   = every invoice that is not cancelled (a credit note counts with its negative total).
 *   Paid    = the paid invoices' totals, plus what was already received on an invoice that is only part paid.
 *   Pending = what is still to pay on the open invoices (their balance, as written on their rows), and, like the website's Expenses tab,
 *             the total of any other status that is neither paid nor cancelled.
 * So Paid + Pending adds up to Total for the usual cases, and a part-paid invoice no longer counts its whole total as pending.
 */
export function billingTotals(rows: ReadonlyArray<Pick<BillingExpense, 'status' | 'currency' | 'total' | 'amount_due' | 'amount_paid'>>): { total: MoneyMap; paid: MoneyMap; pending: MoneyMap } {
  const total: MoneyMap = {}
  const paid: MoneyMap = {}
  const pending: MoneyMap = {}
  const put = (map: MoneyMap, currency: string, n: number) => { if (n) map[currency] = Math.round(((map[currency] ?? 0) + n) * 100) / 100 }
  for (const r of rows) {
    if (r.status === 'Cancelled') continue
    const c = r.currency === 'EUR' ? 'EUR' : 'USD'
    const t = Number(r.total) || 0
    put(total, c, t)
    if (r.status === 'Paid') put(paid, c, t)
    else if (r.status === 'Pending' || r.status === 'Overdue') {
      put(pending, c, billingRowAmount(r))
      const received = Number(r.amount_paid)
      if (received > 0) put(paid, c, received)
    } else put(pending, c, t)
  }
  return { total, paid, pending }
}
