import { createClient } from '@/lib/supabase/server'
import { ClientHealthDashboard } from '@/components/audit/client-health-dashboard'

export default async function ClientHealthPage() {
  const supabase = createClient()

  // ── 1. Stuck activations (payment_confirmed but not activated) ──
  const { data: stuckActivations } = await supabase
    .from('pending_activations')
    .select('id, offer_token, lead_id, client_name, client_email, amount, currency, payment_method, status, signed_at, payment_confirmed_at, activated_at')
    .eq('status', 'payment_confirmed')
    .is('activated_at', null)
    .order('payment_confirmed_at', { ascending: false })

  // Resolve contact info for stuck activations
  const stuckEmails = (stuckActivations ?? []).map(s => s.client_email).filter(Boolean)
  let stuckContactMap: Record<string, { id: string; full_name: string }> = {}
  if (stuckEmails.length > 0) {
    const { data: contacts } = await supabase
      .from('contacts')
      .select('id, full_name, email')
      .in('email', stuckEmails)
    if (contacts) {
      stuckContactMap = Object.fromEntries(
        contacts.map(c => [c.email?.toLowerCase() ?? '', { id: c.id, full_name: c.full_name }])
      )
    }
  }

  const stuckItems = (stuckActivations ?? []).map(s => ({
    ...s,
    contact: stuckContactMap[s.client_email?.toLowerCase() ?? ''] ?? null,
  }))

  // ── 2. Orphan accounts (no contact linked) ──
  const { data: allAccountContacts } = await supabase
    .from('account_contacts')
    .select('account_id')

  const linkedAccountIds = new Set((allAccountContacts ?? []).map(ac => ac.account_id))

  const { data: allAccounts } = await supabase
    .from('accounts')
    .select('id, company_name, status, account_type, entity_type, state_of_formation, created_at')
    .order('created_at', { ascending: false })

  const orphanAccounts = (allAccounts ?? []).filter(a => !linkedAccountIds.has(a.id))

  // ── 3. One-Time accounts with active SDs ──
  const { data: oneTimeAccounts } = await supabase
    .from('accounts')
    .select('id, company_name, status, entity_type')
    .eq('account_type', 'One-Time')

  const oneTimeIds = (oneTimeAccounts ?? []).map(a => a.id)
  let wrongTypeItems: Array<{ id: string; company_name: string; status: string | null; entity_type: string | null; active_sd_count: number }> = []

  if (oneTimeIds.length > 0) {
    const { data: activeSDs } = await supabase
      .from('service_deliveries')
      .select('account_id')
      .in('account_id', oneTimeIds)
      .eq('status', 'active')

    const sdCountMap: Record<string, number> = {}
    for (const sd of activeSDs ?? []) {
      if (sd.account_id) {
        sdCountMap[sd.account_id] = (sdCountMap[sd.account_id] || 0) + 1
      }
    }

    wrongTypeItems = (oneTimeAccounts ?? [])
      .filter(a => sdCountMap[a.id] > 0)
      .map(a => ({ ...a, active_sd_count: sdCountMap[a.id] }))
  }

  // ── 4. Contacts without accounts (with offers or leads) ──
  const { data: contactsWithoutAccounts } = await supabase
    .from('contacts')
    .select('id, full_name, email, portal_tier, status, created_at')
    .eq('status', 'active')
    .order('created_at', { ascending: false })

  const contactIds = (contactsWithoutAccounts ?? []).map(c => c.id)
  const { data: contactAccountLinks } = await supabase
    .from('account_contacts')
    .select('contact_id')
    .in('contact_id', contactIds.slice(0, 500))

  const contactsWithAccountIds = new Set((contactAccountLinks ?? []).map(l => l.contact_id))
  const orphanContacts = (contactsWithoutAccounts ?? []).filter(c => !contactsWithAccountIds.has(c.id))

  // Check which orphan contacts have offers or pending activations
  const orphanContactEmails = orphanContacts.map(c => c.email).filter(Boolean) as string[]
  const contactsWithOffers: Set<string> = new Set()
  if (orphanContactEmails.length > 0) {
    // Check in batches of 50
    for (let i = 0; i < orphanContactEmails.length; i += 50) {
      const batch = orphanContactEmails.slice(i, i + 50)
      const { data: offers } = await supabase
        .from('offers')
        .select('client_email')
        .in('client_email', batch)
      if (offers) {
        for (const o of offers) contactsWithOffers.add(o.client_email?.toLowerCase() ?? '')
      }
    }
  }

  const orphanContactItems = orphanContacts.map(c => ({
    ...c,
    has_offers: contactsWithOffers.has(c.email?.toLowerCase() ?? ''),
  }))

  // ── Stats ──
  const stats = {
    stuck_activations: stuckItems.length,
    orphan_accounts: orphanAccounts.length,
    wrong_type: wrongTypeItems.length,
    orphan_contacts: orphanContacts.length,
    orphan_contacts_with_offers: orphanContactItems.filter(c => c.has_offers).length,
  }

  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Client Health</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Stuck activations, orphan records, and data integrity issues across all clients.
        </p>
      </div>
      <ClientHealthDashboard
        stuckActivations={stuckItems}
        orphanAccounts={orphanAccounts}
        wrongTypeAccounts={wrongTypeItems}
        orphanContacts={orphanContactItems}
        stats={stats}
      />
    </div>
  )
}
