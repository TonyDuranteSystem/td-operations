/**
 * The text each chosen field shows on the Accounts and Contacts lists, in one place so the wide columns and the small line under the
 * name (on a narrower window) always say the same thing. Pure.
 */
import { formatListDate } from '@/lib/crm-lists/format'

export interface ContactCellSource {
  email: string | null
  phone: string | null
  language: string | null
  citizenship: string | null
  portal_tier: string | null
  portal_role: string | null
  passport_on_file: boolean | null
  itin_number: string | null
  created_at: string
  account_count: number
}

const blank = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim()
  return t ? t : null
}

/** The value in its own column; null shows as a dash. */
export function contactCellText(c: ContactCellSource, id: string): string | null {
  switch (id) {
    case 'email':
      return blank(c.email)
    case 'phone':
      return blank(c.phone)
    case 'language':
      return blank(c.language)
    case 'citizenship':
      return blank(c.citizenship)
    case 'passport_on_file':
      return c.passport_on_file ? 'Yes' : null
    case 'itin_on_file':
      return c.itin_number ? 'Yes' : null
    case 'portal_stage':
      return blank(c.portal_tier)
    case 'portal_role':
      return blank(c.portal_role)
    case 'added_on':
      return formatListDate(c.created_at)
    case 'company_count':
      return String(c.account_count)
    default:
      return null
  }
}

/** The same value worded for the small line under the name (nothing when empty). */
export function contactMetaText(c: ContactCellSource, id: string): string | null {
  const v = contactCellText(c, id)
  if (!v) return null
  switch (id) {
    case 'passport_on_file':
      return 'passport on file'
    case 'itin_on_file':
      return 'ITIN on file'
    case 'portal_stage':
      return `portal ${v}`
    case 'portal_role':
      return `role ${v}`
    case 'added_on':
      return `added ${v}`
    case 'company_count':
      return `${v} ${c.account_count === 1 ? 'company' : 'companies'}`
    default:
      return v
  }
}

export interface AccountCellSource {
  entity_type: string | null
  account_type: string | null
  status: string | null
  state_of_formation: string | null
  contact_name: string | null
  contact_email: string | null
  payment_overdue: number
  extras: Record<string, string | null>
}

const ENTITY_SHORT: Record<string, string> = { 'Single Member LLC': 'SMLLC', 'Multi Member LLC': 'MMLLC', 'C-Corp Elected': 'Corp' }

export function accountCellText(a: AccountCellSource, id: string): string | null {
  switch (id) {
    case 'type':
      return a.entity_type ? (ENTITY_SHORT[a.entity_type] ?? a.entity_type) : null
    case 'kind':
      return a.account_type === 'One-Time' ? 'One-time' : blank(a.account_type)
    case 'status':
      return blank(a.status)
    case 'state_of_formation':
      return blank(a.state_of_formation)
    case 'contact':
      return blank(a.contact_name)
    case 'contact_email':
      return blank(a.contact_email)
    case 'overdue':
      return a.payment_overdue > 0 ? String(a.payment_overdue) : null
    default:
      return blank(a.extras[id])
  }
}

/** The same value worded for the small line under the company name (nothing when empty). */
export function accountMetaText(a: AccountCellSource, id: string, label: string): string | null {
  const v = accountCellText(a, id)
  if (!v) return null
  switch (id) {
    case 'type':
    case 'kind':
    case 'status':
    case 'state_of_formation':
    case 'contact':
    case 'contact_email':
    case 'physical_address':
      return v
    case 'overdue':
      return `${v} overdue`
    default:
      return `${label.toLowerCase()} ${v}`
  }
}
