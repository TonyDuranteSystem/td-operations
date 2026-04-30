import { supabaseAdmin } from '@/lib/supabase-admin'
import { AuditShell } from '@/components/clients/audit/audit-shell'
import { computeCompleteness } from '@/lib/audit/completeness-rules'

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

  const accountIds = (accounts ?? []).map((a: { id: string }) => a.id)

  // Fetch contacts and service_deliveries in parallel
  const [{ data: accountContacts }, { data: serviceDels }] = await Promise.all([
    supabaseAdmin
      .from('account_contacts')
      // itin_number is the canonical DB column (contacts.itin column has 0 live rows)
      .select('account_id, is_primary, contact:contacts(id, full_name, email, phone, language, citizenship, itin_number, portal_tier, date_of_birth, passport_number, passport_expiry_date, passport_on_file, kyc_status, address_line1, address_city, address_state, address_zip, address_country)')
      .in('account_id', accountIds),

    // Batch fetch non-cancelled service_deliveries for all accounts at once (avoid N+1)
    supabaseAdmin
      .from('service_deliveries')
      .select('account_id, service_type, status')
      .in('account_id', accountIds)
      .not('status', 'eq', 'Cancelled'),
  ])

  // Build contact map — all contacts per account with is_primary flag
  const contactMap: Record<string, {
    id: string; full_name: string; email: string | null; phone: string | null
    language: string | null; citizenship: string | null; itin_number: string | null
    portal_tier: string | null
    date_of_birth: string | null; passport_number: string | null
    passport_expiry_date: string | null; passport_on_file: boolean | null
    kyc_status: string | null
    address_line1: string | null; address_city: string | null
    address_state: string | null; address_zip: string | null
    address_country: string | null
    is_primary: boolean | null
  }[]> = {}

  for (const row of accountContacts ?? []) {
    if (!row.contact) continue
    if (!contactMap[row.account_id]) contactMap[row.account_id] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contactMap[row.account_id].push({ ...(row.contact as any), is_primary: row.is_primary ?? false })
  }

  // Build service map — active service types per account
  const serviceMap: Record<string, string[]> = {}
  for (const sd of serviceDels ?? []) {
    if (!serviceMap[sd.account_id]) serviceMap[sd.account_id] = []
    serviceMap[sd.account_id].push(sd.service_type)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const enriched = (accounts ?? []).map((a: any) => {
    const contacts = contactMap[a.id] ?? []
    const activeServiceTypes = serviceMap[a.id] ?? []

    // Anomaly score — higher = more urgent
    let score = 0
    if (!a.onboarding_date) score += 3
    if (!a.entity_type) score += 2
    if (contacts.length === 0) score += 2
    if (a.audit_flag) score += 1
    if (!a.audit_reviewed_at) score += 0  // base: all unreviewed equal

    // Primary contact for completeness: prefer is_primary=true, fallback to first
    const primaryContact = contacts.find(c => c.is_primary) ?? contacts[0] ?? null

    const completeness = computeCompleteness(
      {
        entity_type: a.entity_type ?? null,
        ein_number: a.ein_number ?? null,
        state_of_formation: a.state_of_formation ?? null,
        physical_address: a.physical_address ?? null,
        onboarding_date: a.onboarding_date ?? null,
        account_type: a.account_type ?? null,
      },
      primaryContact
        ? {
            full_name: primaryContact.full_name ?? null,
            email: primaryContact.email ?? null,
            itin_number: primaryContact.itin_number ?? null,
            citizenship: primaryContact.citizenship ?? null,
            date_of_birth: primaryContact.date_of_birth ?? null,
            passport_on_file: primaryContact.passport_on_file ?? null,
            address_line1: primaryContact.address_line1 ?? null,
          }
        : null,
      activeServiceTypes,
    )

    return {
      ...a,
      contacts,
      anomaly_score: score,
      audit_sections: (a.audit_sections ?? null) as Record<string, boolean> | null,
      completeness,
    }
  })

  // Sort: unreviewed anomalies first, then reviewed
  enriched.sort((a: { audit_reviewed_at: string | null; anomaly_score: number }, b: { audit_reviewed_at: string | null; anomaly_score: number }) => {
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
