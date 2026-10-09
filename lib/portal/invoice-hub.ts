/**
 * The Invoices area as ONE hub (dev job 1a23f5f1, plan: sysdoc `client-invoicing-plan`):
 * Sales, Customers, Expenses, Vendors and a Setup tab (logo, bank accounts, payment link).
 *
 * Pure rules only, so they are unit-testable:
 *   - the roll-out switch (who sees the hub),
 *   - the tab list (one registry, one function that picks the active tab),
 *   - what is still missing in Setup.
 *
 * LOCKED IN CODE: the tab list and who may see a tab (data may later reorder or hide a tab that code
 * already allows, never grant one). The switch itself is a setting (app_settings.invoice_hub_enabled).
 */

// ── Roll-out switch ────────────────────────────────────────────────────────────

/** `true`/`false`, or `{ enabled, account_ids? }` for a gradual release to chosen companies. */
export type InvoiceHubSetting = boolean | { enabled?: boolean; account_ids?: string[] }

/** Fails CLOSED: anything unreadable means the hub is off and the old pages stay exactly as they were. */
export function isInvoiceHubOnFor(setting: unknown, accountId: string | null | undefined): boolean {
  if (setting === true) return true
  if (!setting || typeof setting !== 'object') return false
  const s = setting as { enabled?: unknown; account_ids?: unknown }
  if (s.enabled !== true) return false
  if (!Array.isArray(s.account_ids)) return true // enabled for everyone
  return !!accountId && s.account_ids.includes(accountId)
}

// ── Tabs ───────────────────────────────────────────────────────────────────────

export type InvoiceTabId = 'sales' | 'customers' | 'expenses' | 'vendors' | 'setup'

export interface InvoiceTabContext {
  /** The client picked / was given a company. A client with no company only has Expenses. */
  hasAccount: boolean
  /** The roll-out switch is on for this company. Off = the old three tabs only. */
  hubOn: boolean
  /** Signed in as the company's own client (not a team member). Customers and Setup are for them. */
  isClient: boolean
}

export interface InvoiceTabDef {
  id: InvoiceTabId
  labelKey: string
  visibleWhen: (ctx: InvoiceTabContext) => boolean
}

// Order = order on screen, and it follows the order a client works in: set up, add the people
// (customers), record sales; add the suppliers (vendors), record expenses.
export const INVOICE_TABS: InvoiceTabDef[] = [
  { id: 'setup',     labelKey: 'invoices.tabSetup',     visibleWhen: c => c.hasAccount && c.hubOn && c.isClient },
  { id: 'customers', labelKey: 'invoices.tabCustomers', visibleWhen: c => c.hasAccount && c.hubOn && c.isClient },
  { id: 'sales',     labelKey: 'invoices.tabSales',     visibleWhen: c => c.hasAccount },
  { id: 'vendors',   labelKey: 'invoices.vendors',      visibleWhen: c => c.hasAccount },
  { id: 'expenses',  labelKey: 'invoices.tabExpenses',  visibleWhen: () => true },
]

// With the hub off the page must stay exactly as it was: Sales, Expenses, Vendors.
const LEGACY_ORDER: InvoiceTabId[] = ['sales', 'expenses', 'vendors']

export function visibleInvoiceTabs(ctx: InvoiceTabContext): InvoiceTabDef[] {
  const visible = INVOICE_TABS.filter(t => t.visibleWhen(ctx))
  if (ctx.hubOn && ctx.isClient) return visible
  return [...visible].sort((a, b) => LEGACY_ORDER.indexOf(a.id) - LEGACY_ORDER.indexOf(b.id))
}

/** What we know about the client when no tab was asked for. */
export interface InvoiceLanding {
  /** The company has already created at least one sales invoice. */
  hasSalesInvoices: boolean
  /** Required Setup items still missing (see missingRequiredCount). */
  setupMissing: number
}

/**
 * Which tab is open.
 *   - A tab asked for in the link wins if the client may see it (the TD billing link opens Expenses).
 *   - `view=paid` (the link in the "payment received" email) always means Expenses.
 *   - With no tab asked for: a client who has not invoiced yet and still has required Setup items
 *     lands on Setup; everyone else lands on Sales (Expenses when there is no company). Returning
 *     clients who simply have no bank account are never sent back to Setup on every visit.
 *   - A tab the client may not see falls back the same way, never an error.
 */
export function resolveInvoiceTab(
  params: { tab?: string; view?: string },
  ctx: InvoiceTabContext,
  landing?: InvoiceLanding,
): InvoiceTabId {
  const visible = visibleInvoiceTabs(ctx).map(t => t.id)
  const wanted = (params.view === 'paid' ? 'expenses' : params.tab) as InvoiceTabId | undefined
  if (wanted && visible.includes(wanted)) return wanted
  if (
    !params.tab && params.view !== 'paid' &&
    visible.includes('setup') && landing && !landing.hasSalesInvoices && landing.setupMissing > 0
  ) {
    return 'setup'
  }
  return visible.includes('sales') ? 'sales' : 'expenses'
}

// ── Setup checklist, driven by the guide definition (lib/portal/guides/guides.ts) ──
import type { ChecklistItemDef, ChecklistRule } from './guides/guides'

export interface EvaluatedChecklistItem {
  id: string
  labelKey: string
  required: boolean
  done: boolean
}

// The rules a checklist item may name. Code owns them; a catalog row can only pick one.
const RULES: Record<ChecklistRule, (f: SetupFacts) => boolean> = {
  logo: f => f.hasLogo,
  payment: f => f.hasBankAccount || f.hasPaymentLink,
  customer: f => f.hasCustomerWithEmail,
}

/** Completion is worked out from live facts each time; it is never stored. */
export function evaluateChecklist(items: ChecklistItemDef[], f: SetupFacts): EvaluatedChecklistItem[] {
  return items.map(i => ({ id: i.id, labelKey: i.labelKey, required: i.required, done: RULES[i.rule](f) }))
}

export function missingRequired(items: EvaluatedChecklistItem[]): number {
  return items.filter(i => i.required && !i.done).length
}

// ── Setup status (built-in checklist, kept for callers that do not load the guide definition) ───────────────────────────────────────────────────────────────

export interface SetupFacts {
  hasLogo: boolean
  hasBankAccount: boolean
  hasPaymentLink: boolean
  /** At least one customer with a usable email. */
  hasCustomerWithEmail: boolean
}

export interface SetupItem {
  id: 'logo' | 'payment' | 'customer'
  required: boolean
  done: boolean
}

/** Completion is worked out from live facts each time; it is never stored. */
export function setupItems(f: SetupFacts): SetupItem[] {
  return [
    { id: 'logo', required: false, done: f.hasLogo },
    { id: 'payment', required: true, done: f.hasBankAccount || f.hasPaymentLink },
    { id: 'customer', required: true, done: f.hasCustomerWithEmail },
  ]
}

export function missingRequiredCount(f: SetupFacts): number {
  return setupItems(f).filter(i => i.required && !i.done).length
}
