/**
 * What the little card shows when you point at a company name or a person's name in the Accounts and Contacts lists (dev job 2b02dfb5,
 * Antonio 2026-11-14: "when I pass on it with the pointer a card shows the information").
 *
 * Pure: it turns what the list already loaded into plain text lines, so the wording is unit-tested and the same on both lists.
 * Left out on purpose: the EIN, passport, ITIN number and date of birth — a card appears on a mere mouse pass, in front of whoever is
 * looking at the screen, and the number never goes to the list page at all.
 */
import { formatMoney } from '@/lib/crm-lists/amounts'
import { INSTALLMENT_CHIP_LABEL, type InstallmentChip } from '@/lib/billing/installment-invoices'

export interface CardLine {
  label: string
  value: string
  /** 'bad' draws the value in red (overdue payments). */
  tone?: 'bad'
}

export interface CardModel {
  title: string
  /** The small grey line under the title. */
  subtitle: string | null
  lines: CardLine[]
  /** A list of short items under the lines (a person's companies). */
  items?: { heading: string; entries: string[] }
}

const ENTITY_SHORT: Record<string, string> = { 'Single Member LLC': 'SMLLC', 'Multi Member LLC': 'MMLLC', 'C-Corp Elected': 'Corp' }

const blank = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim()
  return t ? t : null
}

/** What a company card needs. AccountListItem and the Contacts list's company line both fit it. */
export interface CompanyCardSource {
  company_name: string
  entity_type: string | null
  account_type: string | null
  status: string | null
  state_of_formation: string | null
  /** Already worded ("13 Mar 2026"). */
  client_since: string | null
  contact_name: string | null
  contact_email: string | null
  payment_overdue: number
  installment_1_amount: number | null
  installment_1_currency: string | null
  installment_2_amount: number | null
  installment_2_currency: string | null
  chip_1: InstallmentChip
  chip_2: InstallmentChip
}

/** "$1,250 · Paid" / "$1,250" / "Not set". The chip is only the chosen year's invoice, so no chip means no invoice yet. */
export function installmentLine(amount: number | null, currency: string | null, chip: InstallmentChip): string {
  if (amount == null) return 'Not set'
  const money = formatMoney(amount, currency)
  if (chip.kind === 'not_invoiced') return money
  const word = chip.kind === 'duplicate' ? `${chip.count} invoices` : INSTALLMENT_CHIP_LABEL[chip.kind]
  return `${money} · ${word}`
}

export function companyCard(c: CompanyCardSource, year: number): CardModel {
  const kind = c.account_type === 'One-Time' ? 'One-time' : blank(c.account_type)
  const subtitle = [c.entity_type ? (ENTITY_SHORT[c.entity_type] ?? c.entity_type) : null, kind, blank(c.status)].filter(Boolean).join(' · ')
  const lines: CardLine[] = []
  const state = blank(c.state_of_formation)
  if (state) lines.push({ label: 'State', value: state })
  if (c.client_since) lines.push({ label: 'Client since', value: c.client_since })
  const who = blank(c.contact_name)
  if (who) lines.push({ label: 'Main contact', value: blank(c.contact_email) ? `${who} (${c.contact_email})` : who })
  lines.push({ label: `1st Inst · ${year}`, value: installmentLine(c.installment_1_amount, c.installment_1_currency, c.chip_1) })
  lines.push({ label: `2nd Inst · ${year}`, value: installmentLine(c.installment_2_amount, c.installment_2_currency, c.chip_2) })
  if (c.payment_overdue > 0) {
    lines.push({ label: 'Overdue', value: `${c.payment_overdue} ${c.payment_overdue === 1 ? 'payment' : 'payments'}`, tone: 'bad' })
  }
  return { title: c.company_name, subtitle: subtitle || null, lines }
}

/** What a person card needs. */
export interface PersonCardSource {
  full_name: string
  email: string | null
  phone: string | null
  language: string | null
  portal_tier: string | null
  companies: { company_name: string; status: string | null }[]
}

/** More than this many companies are cut to "+ N more" so the card stays small. */
export const PERSON_CARD_MAX_COMPANIES = 6

export function personCard(p: PersonCardSource): CardModel {
  const stage = blank(p.portal_tier)
  const lines: CardLine[] = []
  const email = blank(p.email)
  const phone = blank(p.phone)
  const language = blank(p.language)
  if (email) lines.push({ label: 'Email', value: email })
  if (phone) lines.push({ label: 'Phone', value: phone })
  if (language) lines.push({ label: 'Language', value: language })
  const shown = p.companies.slice(0, PERSON_CARD_MAX_COMPANIES).map((c) => (blank(c.status) ? `${c.company_name} · ${c.status}` : c.company_name))
  const more = p.companies.length - shown.length
  if (more > 0) shown.push(`+ ${more} more`)
  return {
    title: p.full_name,
    subtitle: stage ? `Portal stage: ${stage}` : null,
    lines,
    items: { heading: p.companies.length === 1 ? 'Company' : 'Companies', entries: shown.length > 0 ? shown : ['No company'] },
  }
}
