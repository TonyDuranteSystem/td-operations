/**
 * Company Closure — the facts the "Wrap-up" panel shows (slice 1 of the Wrap-up pop-up, dev job 5b136702).
 *
 * PURE: no database, no I/O. Every function takes already-read rows and returns plain data, so the rules ("is a lease in
 * force", "is this invoice still owed", "does this open Tax Return hold the closing") are unit-tested without a database.
 * The server loader (wrapup-facts-load.ts) reads the rows and calls these.
 *
 * Rules and where each one comes from (verified, not assumed):
 *  - Lease "in force": status sent/viewed/signed AND term_end on or after today (a lease with no end date counts as in force).
 *    Mirrors the database function td_company_has_lease_in_force, which is what releases the suite when a company is closed.
 *  - Invoice "still owed": the shared isTerminalInvoice rule (lib/finance/invoice-matchability.ts) — an invoice is closed if
 *    EITHER of its two status columns says so, and an open invoice_status wins over an administrative status. "Not Invoiced"
 *    placeholder installments are listed separately because Finance cannot show them.
 *  - Tax return: a Tax Return job is "filed" only at its last step ("TR Filed", which completes the job). Anything before it,
 *    including "TR Completed", is still open. Antonio, 2026-10-15 (choice B): an open Tax Return keeps the company Active.
 *  - Portal: a company shows in a client's portal only while Active or Suspended (lib/portal/queries.ts getPortalAccounts),
 *    so an owner "keeps their login" only if they own another Active/Suspended company.
 */

import { isTerminalInvoice } from '@/lib/finance/invoice-matchability'
import { isLiveDeliveryStatus } from '@/lib/services/stages'
import { isItalian } from '@/lib/locale'

export type SectionResult<T> = { ok: true; data: T } | { ok: false; error: string }

export const TAX_RETURN_SERVICE = 'Tax Return'
/** Both Tax Return job types end at "TR Filed" (the step that completes the job); an open one of either keeps the company Active. */
export const TAX_RETURN_SERVICES: readonly string[] = ['Tax Return', 'Tax Return One-Time']
export const CMRA_SERVICE = 'CMRA Mailing Address'
export const RA_RENEWAL_SERVICE = 'State RA Renewal'
export const ANNUAL_REPORT_SERVICE = 'State Annual Report'

// ───────────────────────────── raw rows (what the loader reads) ─────────────────────────────

export interface RawAccount {
  id: string
  company_name: string | null
  state_of_formation: string | null
  entity_type: string | null
  status: string | null
  registered_agent_provider: string | null
  suite_number: string | null
  portal_tier: string | null
  ra_renewal_date: string | null
  annual_report_due_date: string | null
  cmra_renewal_date: string | null
  ein_number: string | null
  communication_email: string | null
}

export interface RawLease {
  id: string
  status: string | null
  suite_number: string | null
  term_end_date: string | null
}

export interface RawPayment {
  id: string
  description: string | null
  invoice_number: string | null
  status: string | null
  invoice_status: string | null
  total: number | null
  amount: number | null
  amount_paid: number | null
  amount_due: number | null
  amount_currency: string | null
  credit_remaining: number | null
}

export interface RawJob {
  id: string
  service_type: string
  stage: string | null
  status: string | null
  due_date: string | null
}

export interface RawTaxReturn {
  tax_year: number | null
  status: string | null
  paid: boolean | null
}

export interface RawPerson {
  contact_id: string
  full_name: string | null
  email: string | null
  language: string | null
  role: string | null
  /** Names of the OTHER companies this person is linked to that a client portal still lists (Active / Suspended). */
  other_portal_companies: string[]
}

export interface RawMembership {
  /** The company this one is a member of. */
  company_name: string | null
  status: string | null
  ownership_pct: number | null
  /** A stake that has ended (members.end_date in the past) is history, not a current membership. */
  end_date?: string | null
}

// ───────────────────────────── section shapes ─────────────────────────────

export interface WrapUpHeader {
  companyName: string
  state: string | null
  entityType: string | null
  accountStatus: string | null
}

export interface WrapUpRegisteredAgent {
  provider: string | null
  isHarbor: boolean
  /** True when the CRM has no provider recorded (35 real companies have none). */
  missing: boolean
}

export interface WrapUpLease {
  suite: string | null
  inForce: boolean
  /** Latest end date among leases in force; null when none is, or when an in-force lease has no end date. */
  inForceUntil: string | null
  inForceHasNoEndDate: boolean
  draftCount: number
  /** A draft lease names the company's suite: closing frees the suite while the draft still names it. */
  draftNamesSuite: boolean
  /** Closing would return the suite to the pool right away (a suite is set and no lease is in force). */
  suiteFreedAtClose: boolean
}

export interface WrapUpRenewalDate {
  key: 'ra' | 'annual_report' | 'cmra'
  label: string
  date: string
  /** An open renewal job of the matching type exists. */
  hasOpenJob: boolean
}

export interface WrapUpJob {
  id: string
  serviceType: string
  stage: string | null
  status: string | null
  flag: 'blocked' | 'on_hold' | null
  /** The job is already past its first step — closing must never cancel it without an explicit choice. */
  pastFirstStep: boolean
  isTaxReturn: boolean
  isRenewal: boolean
  dueDate: string | null
}

export type WrapUpMoneyKind = 'overdue' | 'pending' | 'delinquent' | 'partial' | 'draft' | 'not_invoiced' | 'open'

export interface WrapUpMoneyItem {
  id: string
  label: string
  invoiceNumber: string | null
  kind: WrapUpMoneyKind
  statusText: string
  total: number | null
  paid: number
  due: number | null
  currency: string
  /** Finance lists only rows that have an invoice document (invoice_status). A row without one cannot be settled from the Finance page. */
  inFinance: boolean
  /** Nothing was paid on it, so it could be voided as "not owed". A part-paid invoice cannot. */
  canVoid: boolean
}

export interface WrapUpMoney {
  items: WrapUpMoneyItem[]
  /** Unspent client credit on credit notes, per currency. Closing would strand it. */
  credit: { currency: string; amount: number }[]
}

export interface WrapUpTax {
  records: { year: number | null; status: string | null; paid: boolean | null }[]
  openJobs: { id: string; stage: string | null; label: string }[]
  /** Antonio's choice B: an open Tax Return job keeps the company Active until it reaches "TR Filed". */
  holdsClosing: boolean
}

export interface WrapUpPerson {
  contactId: string
  name: string
  email: string | null
  languageLabel: string | null
  /** The language the closing email would use. */
  emailLanguage: 'it' | 'en'
  keepsLogin: boolean
  otherCompanies: string[]
}

export interface WrapUpMembership {
  companyName: string
  status: string | null
  ownershipPct: number | null
}

export interface WrapUpCompanyFacts {
  variant: 'company'
  checkedAt: string
  accountId: string
  header: WrapUpHeader
  registeredAgent: WrapUpRegisteredAgent
  portalTier: string | null
  lease: SectionResult<WrapUpLease>
  renewals: SectionResult<{ dates: WrapUpRenewalDate[]; jobs: WrapUpJob[] }>
  jobs: SectionResult<WrapUpJob[]>
  money: SectionResult<WrapUpMoney>
  tax: SectionResult<WrapUpTax>
  people: SectionResult<WrapUpPerson[]>
  memberOf: SectionResult<WrapUpMembership[]>
  /** Plain-English reasons the Close button would stay off today. Informational in the read-only version. */
  holds: string[]
}

export interface WrapUpPersonFacts {
  variant: 'person'
  checkedAt: string
  /** True when reading the person, the closure form or their companies failed; the panel then says the facts are incomplete. */
  readFailed: boolean
  /** The company the closure form names, if the client submitted one. Free text from the client. */
  closureCompanyName: string | null
  closureCompanyState: string | null
  /** What the client wrote about returns already filed (free text, e.g. "Yes" or "2023 2024"). */
  returnsFiledText: string | null
  person: { name: string; email: string | null; languageLabel: string | null } | null
  /** Companies this person owns in the CRM. They are NOT the company being closed (see the note in the panel). */
  personCompanies: { name: string; status: string | null }[]
}

export type WrapUpFacts = WrapUpCompanyFacts | WrapUpPersonFacts

// ───────────────────────────── builders ─────────────────────────────

const clean = (s: string | null | undefined): string | null => {
  const t = (s ?? '').trim()
  return t ? t : null
}

export function buildHeader(a: RawAccount): WrapUpHeader {
  return {
    companyName: clean(a.company_name) ?? 'Unnamed company',
    state: clean(a.state_of_formation),
    entityType: clean(a.entity_type),
    accountStatus: clean(a.status),
  }
}

export function buildRegisteredAgent(a: RawAccount): WrapUpRegisteredAgent {
  const provider = clean(a.registered_agent_provider)
  return { provider, isHarbor: !!provider && /harbor/i.test(provider), missing: !provider }
}

/**
 * today = YYYY-MM-DD as the DATABASE reads it (current_date, UTC) — the suite is released by that function, so the panel must agree with it
 * (the office-time date differs from it for a few hours each evening). The caller passes it; this module never reads the clock.
 */
export function buildLease(account: Pick<RawAccount, 'suite_number'>, leases: RawLease[], today: string): WrapUpLease {
  const suite = clean(account.suite_number)
  const inForceLeases = leases.filter(
    (l) => ['sent', 'viewed', 'signed'].includes((l.status ?? '').trim().toLowerCase()) && (l.term_end_date ?? '9999-12-31') >= today,
  )
  const drafts = leases.filter((l) => (l.status ?? '').trim().toLowerCase() === 'draft')
  const dated = inForceLeases.map((l) => l.term_end_date).filter((d): d is string => !!d)
  const noEnd = inForceLeases.some((l) => !l.term_end_date)
  const inForce = inForceLeases.length > 0
  return {
    suite,
    inForce,
    inForceUntil: inForce && !noEnd && dated.length ? dated.sort().slice(-1)[0] : null,
    inForceHasNoEndDate: inForce && noEnd,
    draftCount: drafts.length,
    draftNamesSuite: !!suite && drafts.some((l) => clean(l.suite_number) === suite),
    suiteFreedAtClose: !!suite && !inForce,
  }
}

/**
 * Step numbers per service type, read from the step list (pipeline_stages), NOT from the job: the job's own copy of the step number is
 * often empty or stale (app/(dashboard)/flows/[id]/page.tsx). `byName` is keyed by the exact step name.
 */
export interface StageOrders {
  first: number
  byName: Record<string, number>
}

export function buildJobs(jobs: RawJob[], stageOrdersByType: Record<string, StageOrders>, excludeJobId?: string): WrapUpJob[] {
  return jobs
    .filter((j) => j.id !== excludeJobId && isLiveDeliveryStatus(j.status))
    .map((j) => {
      const status = (j.status ?? '').trim().toLowerCase()
      const orders = stageOrdersByType[j.service_type]
      const current = orders && j.stage ? orders.byName[j.stage.trim()] : undefined
      return {
        id: j.id,
        serviceType: j.service_type,
        stage: clean(j.stage),
        status: clean(j.status),
        flag: status === 'blocked' ? ('blocked' as const) : status === 'on_hold' || status === 'on hold' ? ('on_hold' as const) : null,
        pastFirstStep: !!orders && current !== undefined && current > orders.first,
        isTaxReturn: TAX_RETURN_SERVICES.includes(j.service_type),
        isRenewal: j.service_type === RA_RENEWAL_SERVICE || j.service_type === ANNUAL_REPORT_SERVICE,
        dueDate: j.due_date,
      }
    })
}

export function buildRenewals(account: RawAccount, jobs: WrapUpJob[]): { dates: WrapUpRenewalDate[]; jobs: WrapUpJob[] } {
  const hasJob = (type: string) => jobs.some((j) => j.serviceType === type)
  const dates: WrapUpRenewalDate[] = []
  if (account.ra_renewal_date) dates.push({ key: 'ra', label: 'Registered agent renewal', date: account.ra_renewal_date, hasOpenJob: hasJob(RA_RENEWAL_SERVICE) })
  if (account.annual_report_due_date) dates.push({ key: 'annual_report', label: 'Annual report', date: account.annual_report_due_date, hasOpenJob: hasJob(ANNUAL_REPORT_SERVICE) })
  if (account.cmra_renewal_date) dates.push({ key: 'cmra', label: 'Mailing address (CMRA) renewal', date: account.cmra_renewal_date, hasOpenJob: hasJob(CMRA_SERVICE) })
  return { dates, jobs: jobs.filter((j) => j.isRenewal) }
}

const num = (n: number | null | undefined): number | null => (typeof n === 'number' && Number.isFinite(n) ? n : null)

export function classifyPayment(p: RawPayment): WrapUpMoneyItem | null {
  const status = clean(p.status)
  const invoiceStatus = clean(p.invoice_status)
  const notInvoiced = status === 'Not Invoiced' && !invoiceStatus
  // A credit note is money TD owes the client, never money the client owes.
  if (invoiceStatus === 'Credit') return null
  if (!notInvoiced && isTerminalInvoice({ status, invoice_status: invoiceStatus })) return null

  const total = num(p.total) ?? num(p.amount)
  const paid = num(p.amount_paid) ?? 0
  const due = num(p.amount_due) ?? (total !== null ? Math.max(0, total - paid) : null)
  let kind: WrapUpMoneyKind
  if (notInvoiced) kind = 'not_invoiced'
  else if (invoiceStatus === 'Partial' || (paid > 0 && (due ?? 0) > 0)) kind = 'partial'
  else if (invoiceStatus === 'Draft') kind = 'draft'
  else if (invoiceStatus === 'Overdue' || status === 'Overdue') kind = 'overdue'
  else if (status === 'Delinquent') kind = 'delinquent'
  else if (status === 'Pending') kind = 'pending'
  else kind = 'open'

  const statusText = { overdue: 'Overdue', pending: 'Pending', delinquent: 'Delinquent', partial: 'Part-paid', draft: 'Draft, not sent', not_invoiced: 'Never invoiced', open: invoiceStatus ?? status ?? 'Open' }[kind]
  return {
    id: p.id,
    label: clean(p.description) ?? 'Invoice',
    invoiceNumber: clean(p.invoice_number),
    kind,
    statusText,
    total,
    paid,
    due,
    currency: clean(p.amount_currency) ?? 'USD',
    inFinance: !!invoiceStatus,
    canVoid: paid === 0 && kind !== 'partial',
  }
}

export function buildMoney(payments: RawPayment[]): WrapUpMoney {
  const items = payments.map(classifyPayment).filter((x): x is WrapUpMoneyItem => x !== null)
  const byCurrency = new Map<string, number>()
  for (const p of payments) {
    const left = num(p.credit_remaining) ?? 0
    if (clean(p.invoice_status) !== 'Credit' || left <= 0) continue
    const cur = clean(p.amount_currency) ?? 'USD'
    byCurrency.set(cur, (byCurrency.get(cur) ?? 0) + left)
  }
  const credit = Array.from(byCurrency, ([currency, amount]) => ({ currency, amount: Math.round(amount * 100) / 100 }))
  return { items, credit }
}

export function buildTax(records: RawTaxReturn[], jobs: WrapUpJob[]): WrapUpTax {
  const openJobs = jobs
    // "Terminated - Non Payment" is a dead end, not a return that is being worked on.
    .filter((j) => j.isTaxReturn && !(j.stage ?? '').toLowerCase().startsWith('terminated'))
    .map((j) => ({ id: j.id, stage: j.stage, label: `${j.serviceType}${j.stage ? ` · ${j.stage}` : ''}` }))
  return {
    records: records.map((r) => ({ year: r.tax_year, status: clean(r.status), paid: r.paid })),
    openJobs,
    holdsClosing: openJobs.length > 0,
  }
}

export function buildPeople(rows: RawPerson[]): WrapUpPerson[] {
  return rows.map((p) => ({
    contactId: p.contact_id,
    name: clean(p.full_name) ?? 'Unnamed person',
    email: clean(p.email),
    languageLabel: clean(p.language),
    emailLanguage: isItalian(p.language) ? ('it' as const) : ('en' as const),
    keepsLogin: p.other_portal_companies.length > 0,
    otherCompanies: p.other_portal_companies,
  }))
}

export function buildMemberships(rows: RawMembership[], today?: string): WrapUpMembership[] {
  return rows
    .filter((m) => !today || !m.end_date || m.end_date >= today)
    .map((m) => ({ companyName: clean(m.company_name) ?? 'Unnamed company', status: clean(m.status), ownershipPct: num(m.ownership_pct) }))
}

/**
 * Plain-English reasons the Close button would stay off. EVERY section can speak: one that could not be read holds the closing and
 * says so (fail closed), so the summary never reads "nothing found" next to a red "could not check" box.
 */
export function buildHolds(sections: {
  tax: SectionResult<WrapUpTax>
  money: SectionResult<WrapUpMoney>
  lease?: SectionResult<unknown>
  renewals?: SectionResult<unknown>
  jobs?: SectionResult<unknown>
  people?: SectionResult<unknown>
  memberOf?: SectionResult<unknown>
}): string[] {
  const holds: string[] = []
  if (sections.tax.ok === false) holds.push('Could not check the tax return. Closing stays off until it can be checked.')
  else if (sections.tax.data.holdsClosing) {
    const first = sections.tax.data.openJobs[0]
    holds.push(`A Tax Return is still open (${first.label}). The company stays Active until it is filed.`)
  }
  if (sections.money.ok === false) holds.push('Could not check the payments. Closing stays off until they can be checked.')
  else {
    const n = sections.money.data.items.length
    if (n > 0) holds.push(`${n} unpaid or uninvoiced item${n === 1 ? '' : 's'} must be settled, voided as not owed, or kept owed with a note.`)
  }
  const others: [string, SectionResult<unknown> | undefined][] = [
    ['the lease', sections.lease],
    ['the renewals', sections.renewals],
    ['the open services', sections.jobs],
    ['the owners', sections.people],
    ['the companies this one belongs to', sections.memberOf],
  ]
  for (const [what, r] of others) if (r && r.ok === false) holds.push(`Could not check ${what}. Closing stays off until it can be checked.`)
  return holds
}

export { closingEmailRecipients } from '@/lib/closure/wrapup-email'
