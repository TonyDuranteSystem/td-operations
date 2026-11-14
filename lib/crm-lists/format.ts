/**
 * Small display helpers for the extra fields on the Accounts and Contacts lists. Pure.
 */
import { companyOfficialRow, formatAddressString, resolveMailingAddress, type MailingAddressRow } from '@/lib/addresses'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * "2026-03-04" or "2026-03-04T10:00:00Z" -> "04 Mar 2026". The calendar part of the stored text is used as it is (a date column has no
 * time zone, and shifting it would show the wrong day); null / unreadable -> null.
 */
export function formatListDate(value: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? '')
  if (!m) return null
  const month = Number(m[2])
  if (month < 1 || month > 12) return null
  return `${m[3]} ${MONTHS[month - 1]} ${m[1]}`
}

/**
 * A full timestamp ("2026-11-14T02:30:00Z", e.g. when a contact was added) -> the New York calendar day, "13 Nov 2026". Unlike a DATE
 * column, a timestamp has a time of day, so cutting its first ten characters would show the UTC day, which can be tomorrow in New York.
 */
export function formatListTimestamp(value: string | null | undefined): string | null {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  return formatListDate(parts)
}

/** "Yes" for true; nothing (null) otherwise, so the cell shows a dash. */
export function yesOrNull(value: boolean | null | undefined): string | null {
  return value ? 'Yes' : null
}

/** 'single_member' -> 'Single member'; plain text unchanged; empty -> null. */
export function plainText(value: string | null | undefined): string | null {
  const t = (value ?? '').trim()
  return t ? t : null
}

/**
 * A company's physical address as the rest of the system reads it: the official address built from its suite number when it has one,
 * else the saved mailing address, else the old text field. The raw `physical_address` column alone is empty for many companies.
 */
export function resolvePhysicalAddress(args: {
  suite_number: string | null
  physical_address: string | null
  mailing_address: MailingAddressRow | null | undefined
}): string | null {
  return formatAddressString(companyOfficialRow(args.suite_number)) ?? resolveMailingAddress(args.mailing_address, args.physical_address)
}
