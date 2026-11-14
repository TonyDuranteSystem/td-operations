/**
 * The display text for the extra fields on the Accounts list, built ONLY for the fields the person chose.
 *
 * Why only the chosen ones: the EIN, the address and the like should not travel to the screen when nobody asked for them. Pure.
 */
import { pmbLabel, type MailingAddressRow } from '@/lib/addresses'
import { formatListDate, plainText, resolvePhysicalAddress } from '@/lib/crm-lists/format'

export interface AccountExtraRow {
  formation_date: string | null
  client_since: string | null
  onboarding_date: string | null
  member_count: number | null
  ein_number: string | null
  suite_number: string | null
  physical_address: string | null
  mailing_address: MailingAddressRow | null | undefined
  registered_agent_provider: string | null
  ra_renewal_date: string | null
  annual_report_due_date: string | null
  lead_source: string | null
  referrer: string | null
  portal_tier: string | null
}

export function accountExtras(selected: string[], r: AccountExtraRow): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const id of selected) {
    switch (id) {
      case 'formation_date':
        out[id] = formatListDate(r.formation_date)
        break
      case 'client_since':
        out[id] = formatListDate(r.client_since)
        break
      case 'onboarding_date':
        out[id] = formatListDate(r.onboarding_date)
        break
      case 'member_count':
        out[id] = r.member_count != null ? String(r.member_count) : null
        break
      case 'ein':
        out[id] = plainText(r.ein_number)
        break
      case 'suite_number':
        // Staff see "PMB 318", never the stored "3D-318" (same as everywhere else in the CRM).
        out[id] = pmbLabel(r.suite_number) ?? plainText(r.suite_number)
        break
      case 'physical_address':
        out[id] = resolvePhysicalAddress({ suite_number: r.suite_number, physical_address: r.physical_address, mailing_address: r.mailing_address })
        break
      case 'registered_agent':
        out[id] = plainText(r.registered_agent_provider)
        break
      case 'ra_renewal_date':
        out[id] = formatListDate(r.ra_renewal_date)
        break
      case 'annual_report_due_date':
        out[id] = formatListDate(r.annual_report_due_date)
        break
      case 'lead_source':
        out[id] = plainText(r.lead_source)
        break
      case 'referrer':
        out[id] = plainText(r.referrer)
        break
      case 'portal_stage':
        out[id] = plainText(r.portal_tier)
        break
      default:
        break
    }
  }
  return out
}
