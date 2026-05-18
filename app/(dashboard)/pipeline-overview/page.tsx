import Link from 'next/link'
import { differenceInDays } from 'date-fns'
import { createClient } from '@/lib/supabase/server'
import { SERVICE_TYPE_TO_SLUG } from '@/lib/constants'
import { JourneyBoard, type ServiceGroup, type StageColumn, type SDCard } from '@/components/pipeline/journey-board'

export default async function PipelineOverviewPage() {
  const supabase = createClient()

  const [{ data: sds }, { data: pipelineStages }] = await Promise.all([
    supabase
      .from('service_deliveries')
      .select('id, service_type, stage, stage_order, stage_entered_at, account_id')
      .eq('status', 'active')
      .or('is_test.is.null,is_test.eq.false'),
    supabase
      .from('pipeline_stages')
      .select('service_type, stage_order, stage_name, sla_days')
      .order('service_type')
      .order('stage_order'),
  ])

  // Fetch account names and payments for all unique account_ids
  const accountIds = Array.from(new Set((sds ?? []).map(sd => sd.account_id).filter(Boolean)))
  let accountMap: Record<string, string> = {}
  // payments keyed by account_id → list
  type PaymentRow = { account_id: string; description: string | null; invoice_number: string | null; status: string | null; amount: number | null }
  const paymentsByAccount: Record<string, PaymentRow[]> = {}

  if (accountIds.length > 0) {
    const [{ data: accounts }, { data: payments }] = await Promise.all([
      supabase
        .from('accounts')
        .select('id, company_name')
        .in('id', accountIds),
      supabase
        .from('payments')
        .select('account_id, description, invoice_number, status, amount')
        .in('account_id', accountIds)
        .not('invoice_number', 'is', null),
    ])
    accountMap = Object.fromEntries((accounts ?? []).map(a => [a.id, a.company_name]))
    for (const p of payments ?? []) {
      if (!p.account_id) continue
      if (!paymentsByAccount[p.account_id]) paymentsByAccount[p.account_id] = []
      paymentsByAccount[p.account_id].push(p as PaymentRow)
    }
  }

  const now = new Date()

  // sla map: serviceType → stageName → sla_days
  const slaMap: Record<string, Record<string, number | null>> = {}
  for (const ps of pipelineStages ?? []) {
    if (!ps.service_type || !ps.stage_name) continue
    if (!slaMap[ps.service_type]) slaMap[ps.service_type] = {}
    slaMap[ps.service_type][ps.stage_name] = ps.sla_days
  }

  // stages map: serviceType → ordered array
  const stagesMap: Record<string, { stage_name: string; sla_days: number | null; stage_order: number }[]> = {}
  for (const ps of pipelineStages ?? []) {
    if (!ps.service_type) continue
    if (!stagesMap[ps.service_type]) stagesMap[ps.service_type] = []
    stagesMap[ps.service_type].push({
      stage_name: ps.stage_name,
      sla_days: ps.sla_days,
      stage_order: ps.stage_order,
    })
  }

  // ── Daily Queue ──────────────────────────────────────────────────────────────
  // Flat list of all active SDs, sorted by daysAtStage desc (oldest first)
  type QueueRow = {
    id: string
    accountId: string
    companyName: string
    serviceType: string
    stage: string
    daysAtStage: number | null
    slaDays: number | null
    invoiceNumber: string | null
    invoiceStatus: string | null
    invoiceAmount: number | null
  }

  const queueRows: QueueRow[] = (sds ?? [])
    .filter(sd => sd.service_type && sd.account_id)
    .map(sd => {
      const stage = sd.stage ?? '—'
      const slaDays = sd.service_type && slaMap[sd.service_type]
        ? (slaMap[sd.service_type][stage] ?? null)
        : null
      const daysAtStage = sd.stage_entered_at ? differenceInDays(now, new Date(sd.stage_entered_at)) : null

      // Match most recent invoice for this SD: description === service_type
      const acctPayments = sd.account_id ? (paymentsByAccount[sd.account_id] ?? []) : []
      const matchingInvoice = acctPayments
        .filter(p => p.description === sd.service_type)
        .sort((a, b) => (b.invoice_number ?? '').localeCompare(a.invoice_number ?? ''))
        [0] ?? null

      return {
        id: sd.id,
        accountId: sd.account_id ?? '',
        companyName: sd.account_id ? (accountMap[sd.account_id] ?? 'Unknown') : 'No Account',
        serviceType: sd.service_type ?? '',
        stage,
        daysAtStage,
        slaDays,
        invoiceNumber: matchingInvoice?.invoice_number ?? null,
        invoiceStatus: matchingInvoice?.status ?? null,
        invoiceAmount: matchingInvoice?.amount ?? null,
      }
    })
    .sort((a, b) => (b.daysAtStage ?? 0) - (a.daysAtStage ?? 0))

  // ── Kanban ───────────────────────────────────────────────────────────────────
  // group: serviceType → stageName → SDCard[]
  const grouped: Record<string, Record<string, SDCard[]>> = {}
  for (const sd of sds ?? []) {
    const type = sd.service_type
    const stage = sd.stage ?? '—'
    if (!type) continue
    if (!grouped[type]) grouped[type] = {}
    if (!grouped[type][stage]) grouped[type][stage] = []
    grouped[type][stage].push({
      id: sd.id,
      accountId: sd.account_id ?? '',
      companyName: sd.account_id ? (accountMap[sd.account_id] ?? 'Unknown') : 'No Account',
      daysAtStage: sd.stage_entered_at ? differenceInDays(now, new Date(sd.stage_entered_at)) : null,
    })
  }

  const serviceGroups: ServiceGroup[] = Object.entries(grouped)
    .map(([serviceType, stageCards]): ServiceGroup => {
      const orderedStages = stagesMap[serviceType] ?? []
      const knownNames = new Set(orderedStages.map(s => s.stage_name))
      const extraStages = Object.keys(stageCards)
        .filter(n => !knownNames.has(n))
        .map(n => ({ stage_name: n, sla_days: null as number | null, stage_order: 999 }))
      const allStages = [...orderedStages, ...extraStages]

      const stages: StageColumn[] = allStages.map(s => ({
        stageName: s.stage_name,
        slaDays: s.sla_days,
        cards: (stageCards[s.stage_name] ?? []).sort(
          (a, b) => (b.daysAtStage ?? 0) - (a.daysAtStage ?? 0),
        ),
      }))

      return {
        serviceType,
        trackerSlug: SERVICE_TYPE_TO_SLUG[serviceType] ?? null,
        totalActive: Object.values(stageCards).reduce((n, c) => n + c.length, 0),
        stages,
      }
    })
    .filter(g => g.totalActive > 0)
    .sort((a, b) => b.totalActive - a.totalActive)

  return (
    <div className="p-6 lg:p-8 space-y-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Pipeline Overview</h1>
        <p className="text-muted-foreground text-sm mt-1">
          All active service deliveries across every pipeline — oldest cards surface first.
        </p>
      </div>

      {/* ── Daily Queue ─────────────────────────────────────────────────────── */}
      <section>
        <h2 className="text-base font-semibold mb-3">Daily Queue</h2>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Client</th>
                <th className="px-4 py-2.5 font-medium">Service</th>
                <th className="px-4 py-2.5 font-medium">Stage</th>
                <th className="px-4 py-2.5 font-medium text-right">Days</th>
                <th className="px-4 py-2.5 font-medium">Invoice</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {queueRows.map(row => {
                const overSla = row.slaDays != null && row.daysAtStage != null && row.daysAtStage > row.slaDays
                const nearSla = !overSla && row.slaDays != null && row.daysAtStage != null && row.daysAtStage >= row.slaDays * 0.75

                const daysBadge = row.daysAtStage == null ? (
                  <span className="text-muted-foreground">—</span>
                ) : overSla ? (
                  <span className="font-semibold text-red-600">{row.daysAtStage}d</span>
                ) : nearSla ? (
                  <span className="font-semibold text-amber-600">{row.daysAtStage}d</span>
                ) : (
                  <span className="text-foreground">{row.daysAtStage}d</span>
                )

                const invoiceCell = row.invoiceNumber ? (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="font-mono text-xs text-foreground">{row.invoiceNumber}</span>
                    {row.invoiceAmount != null && (
                      <span className="text-muted-foreground">${row.invoiceAmount.toLocaleString()}</span>
                    )}
                    <InvoiceStatusBadge status={row.invoiceStatus} />
                  </span>
                ) : (
                  <span className="text-muted-foreground text-xs">No invoice</span>
                )

                return (
                  <tr key={row.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-2.5">
                      <Link
                        href={`/portal-chats?account=${row.accountId}`}
                        className="font-medium text-foreground hover:underline"
                      >
                        {row.companyName}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">{row.serviceType}</td>
                    <td className="px-4 py-2.5">{row.stage}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{daysBadge}</td>
                    <td className="px-4 py-2.5">{invoiceCell}</td>
                  </tr>
                )
              })}
              {queueRows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                    No active service deliveries.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Kanban board ────────────────────────────────────────────────────── */}
      <section>
        <h2 className="text-base font-semibold mb-3">Board View</h2>
        <JourneyBoard groups={serviceGroups} />
      </section>
    </div>
  )
}

function InvoiceStatusBadge({ status }: { status: string | null }) {
  if (!status) return null
  const map: Record<string, { label: string; cls: string }> = {
    Paid: { label: 'Paid', cls: 'bg-green-50 text-green-700 border-green-200' },
    paid: { label: 'Paid', cls: 'bg-green-50 text-green-700 border-green-200' },
    Sent: { label: 'Sent', cls: 'bg-blue-50 text-blue-700 border-blue-200' },
    sent: { label: 'Sent', cls: 'bg-blue-50 text-blue-700 border-blue-200' },
    Draft: { label: 'Draft', cls: 'bg-zinc-50 text-zinc-600 border-zinc-200' },
    draft: { label: 'Draft', cls: 'bg-zinc-50 text-zinc-600 border-zinc-200' },
    Overdue: { label: 'Overdue', cls: 'bg-red-50 text-red-700 border-red-200' },
    overdue: { label: 'Overdue', cls: 'bg-red-50 text-red-700 border-red-200' },
  }
  const entry = map[status]
  if (!entry) return <span className="text-xs text-muted-foreground">{status}</span>
  return (
    <span className={`inline-block text-[10px] border px-1.5 py-0.5 rounded-full font-medium ${entry.cls}`}>
      {entry.label}
    </span>
  )
}
