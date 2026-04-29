import { supabaseAdmin } from '@/lib/supabase-admin'
import { AuditShell } from '@/components/clients/audit/audit-shell'

export const dynamic = 'force-dynamic'

export default async function ClientAuditPage() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: accounts, error: accErr } = await (supabaseAdmin as any)
    .from('accounts')
    .select(`
      id,
      company_name,
      status,
      entity_type,
      account_type,
      formation_date,
      onboarding_date,
      ein_number,
      filing_id,
      state_of_formation,
      physical_address,
      notes,
      installment_1_amount,
      installment_1_currency,
      installment_2_amount,
      installment_2_currency,
      setup_fee_amount,
      setup_fee_invoice,
      setup_fee_date,
      audit_reviewed_at,
      audit_reviewed_by,
      audit_flag,
      audit_sections,
      drive_folder_id
    `)
    .not('status', 'in', '("Cancelled","Closed")')
    .order('company_name')

  if (accErr) {
    return <div className="p-8 text-red-600 font-mono text-sm">DB Error: {accErr.message}</div>
  }

  const accountIds = (accounts ?? []).map(a => a.id)

  const { data: accountContacts } = await supabaseAdmin
    .from('account_contacts')
    .select('account_id, contact:contacts(id, full_name, email, phone, language, citizenship, itin, portal_tier, date_of_birth, passport_number, passport_expiry_date, passport_on_file, kyc_status, address_line1, address_city, address_state, address_zip, address_country)')
    .in('account_id', accountIds)

  // Build contact map — all contacts per account
  const contactMap: Record<string, {
    id: string; full_name: string; email: string | null; phone: string | null
    language: string | null; citizenship: string | null; itin: string | null
    portal_tier: string | null
    date_of_birth: string | null; passport_number: string | null
    passport_expiry_date: string | null; passport_on_file: boolean | null
    kyc_status: string | null
    address_line1: string | null; address_city: string | null
    address_state: string | null; address_zip: string | null
    address_country: string | null
  }[]> = {}

  for (const row of accountContacts ?? []) {
    if (!row.contact) continue
    if (!contactMap[row.account_id]) contactMap[row.account_id] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contactMap[row.account_id].push(row.contact as any)
  }

  const enriched = (accounts ?? []).map(a => {
    const contacts = contactMap[a.id] ?? []
    // Anomaly score — higher = more urgent
    let score = 0
    if (!a.onboarding_date) score += 3
    if (!a.entity_type) score += 2
    if (contacts.length === 0) score += 2
    if (a.audit_flag) score += 1
    if (!a.audit_reviewed_at) score += 0  // base: all unreviewed equal
    return {
      ...a,
      contacts,
      anomaly_score: score,
      audit_sections: (a.audit_sections ?? null) as Record<string, boolean> | null,
    }
  })

  // Sort: unreviewed anomalies first, then reviewed
  enriched.sort((a, b) => {
    const aReviewed = !!a.audit_reviewed_at
    const bReviewed = !!b.audit_reviewed_at
    if (aReviewed !== bReviewed) return aReviewed ? 1 : -1
    return b.anomaly_score - a.anomaly_score
  })

  const total = enriched.length

  return (
    <AuditShell
      accounts={enriched}
      total={total}
    />
  )
}
