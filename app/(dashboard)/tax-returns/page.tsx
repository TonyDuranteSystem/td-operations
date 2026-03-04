import { createClient } from '@/lib/supabase/server'
import { TaxBoard } from '@/components/tax-returns/tax-board'
import type { TaxReturn, TaxSection } from '@/lib/types'

const SECTION_DEFS = [
  { key: 'da_elaborare', title: 'Da Elaborare', statuses: ['Payment Pending', 'Paid - Need Deal', 'Deal Created - Need Link'], color: 'amber', icon: 'clipboard' },
  { key: 'attesa_dati', title: 'Attesa Dati', statuses: ['Link Sent - Awaiting Data'], color: 'orange', icon: 'clock' },
  { key: 'pronti_india', title: 'Pronti India', statuses: ['Data Received'], color: 'blue', icon: 'send' },
  { key: 'in_corso_india', title: 'In Corso India', statuses: ['Sent to India'], color: 'indigo', icon: 'loader' },
  { key: 'extension', title: 'Extension Filed', statuses: ['Extension Filed'], color: 'purple', icon: 'calendar' },
  { key: 'completati', title: 'Completati', statuses: ['TR Completed - Awaiting Signature', 'TR Filed'], color: 'emerald', icon: 'check' },
]

export default async function TaxReturnsPage() {
  const supabase = createClient()
  const today = new Date().toISOString().split('T')[0]

  const { data: rawReturns } = await supabase
    .from('tax_returns')
    .select('id, company_name, client_name, return_type, tax_year, deadline, status, paid, data_received, sent_to_india, india_status, special_case, extension_filed, extension_deadline, notes, updated_at')
    .eq('tax_year', 2025)
    .order('deadline', { ascending: true })

  const returns: TaxReturn[] = rawReturns ?? []

  // Separate special cases
  const specialCases = returns.filter(tr => tr.special_case === true)
  const specialIds = new Set(specialCases.map(tr => tr.id))

  // Group remaining by status
  const sections: TaxSection[] = SECTION_DEFS.map(def => ({
    ...def,
    items: returns.filter(tr => !specialIds.has(tr.id) && def.statuses.includes(tr.status)),
  }))

  // Add special cases section before completati
  sections.splice(sections.length - 1, 0, {
    key: 'speciali',
    title: 'Casi Speciali',
    items: specialCases,
    color: 'rose',
    icon: 'alert',
  })

  const stats = {
    total: returns.length,
    mmllc: returns.filter(tr => tr.return_type === 'MMLLC').length,
    smllc: returns.filter(tr => tr.return_type === 'SMLLC').length,
    paid: returns.filter(tr => tr.paid).length,
    dataReceived: returns.filter(tr => tr.data_received).length,
    extensionFiled: returns.filter(tr => tr.extension_filed).length,
  }

  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Tax Returns 2025</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Tracker dichiarazioni fiscali — MMLLC deadline 15 Mar, SMLLC deadline 15 Apr
        </p>
      </div>
      <TaxBoard sections={sections} stats={stats} today={today} />
    </div>
  )
}
