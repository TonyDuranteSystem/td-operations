import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { parseStageLayout } from '@/lib/flows/stage-layout'
import { deriveFlowYear } from '@/lib/flows/resolve-flows'
import { StageStepper, type StepperStage } from '@/components/flows/stage-stepper'
import { StageRenderer } from '@/components/flows/stage-renderer'
import { GoBackButton } from '@/components/flows/go-back-button'
import { ItinOriginCard, type ItinOrigin } from '@/components/flows/itin-origin-card'
import { filedName, type NameCheck } from '@/lib/flows/name-checks'
import { APP_BASE_URL } from '@/lib/config'
import type { WorkspaceServiceDelivery, WorkspaceAccount, WorkspaceInvoice } from '@/components/flows/types'

export const dynamic = 'force-dynamic'

/**
 * Flow Workspace — full page for a single service_delivery. The [id] is a
 * service_delivery_id. The stage's UI is driven by pipeline_stages.stage_layout
 * for the SD's current stage (matched by stage NAME, since stage_order on the SD
 * is frequently NULL).
 */
export default async function FlowWorkspacePage({ params }: { params: { id: string } }) {
  const { data: sd } = await supabaseAdmin
    .from('service_deliveries')
    .select('id, service_type, stage, stage_order, status, assigned_to, due_date, stage_entered_at, created_at, account_id, contact_id')
    .eq('id', params.id)
    .single()

  if (!sd || !sd.service_type) notFound()

  // Client-submitted shipping info (ITIN). Untyped: shipping_* columns were added
  // by 20260616-2300-itin-shipping-tracking.sql and aren't in the generated types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: shipRow } = await (supabaseAdmin as any)
    .from('service_deliveries')
    .select('shipping_courier, shipping_tracking_number, shipping_submitted_at')
    .eq('id', params.id)
    .maybeSingle()

  // Company Formation "Company Created" milestone — when the SD reaches
  // "Articles Received", surface the confirmed LLC name (the candidate filed
  // with the SOS, status 'filed' in the SD's name_checks JSONB).
  let companyCreatedName: string | null = null
  if (sd.service_type === 'Company Formation' && sd.stage === 'Articles Received') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- name_checks not in generated types
    const { data: ncRow } = await (supabaseAdmin as any)
      .from('service_deliveries')
      .select('name_checks')
      .eq('id', params.id)
      .maybeSingle()
    companyCreatedName = filedName((ncRow?.name_checks as NameCheck[] | null) ?? null)
  }

  const [{ data: accountRow }, { data: stageRows }] = await Promise.all([
    sd.account_id
      ? supabaseAdmin.from('accounts').select('id, company_name, state_of_formation, annual_report_due_date, ra_renewal_date').eq('id', sd.account_id).single()
      : Promise.resolve({ data: null }),
    supabaseAdmin
      .from('pipeline_stages')
      .select('stage_name, stage_order, icon, client_label, stage_layout')
      .eq('service_type', sd.service_type)
      .order('stage_order', { ascending: true }),
  ])

  // Cast via unknown: stage_layout was added by the S0 migration but the
  // generated DB types haven't been regenerated yet (gen:types pending).
  const stages = (stageRows ?? []) as unknown as Array<{
    stage_name: string
    stage_order: number
    icon: string | null
    client_label: string | null
    stage_layout: unknown
  }>

  // Match the current stage by NAME (SD.stage_order is often NULL/stale).
  const currentStageRow = stages.find((s) => s.stage_name === sd.stage) ?? null
  const layout = parseStageLayout(currentStageRow?.stage_layout)
  const year = deriveFlowYear(sd)

  // Previous stage (highest stage_order below the current one) drives the
  // "← Go Back" button — hidden on the first stage. Resolved by stage_order
  // from the pipeline catalog, matching the revert route's server-side logic.
  const previousStageRow = currentStageRow
    ? stages
        .filter((s) => s.stage_order < currentStageRow.stage_order)
        .sort((a, b) => b.stage_order - a.stage_order)[0] ?? null
    : null

  // In-flight Company Formations are contact-scoped (no account yet), so the
  // state of formation lives on the formation wizard, not the account. Surface
  // it so the SoS external_link resolves the right state (defaults to NM).
  let formationState: string | null = null
  if (sd.service_type === 'Company Formation' && !sd.account_id && sd.contact_id) {
    const { data: wp } = await supabaseAdmin
      .from('wizard_progress')
      .select('data')
      .eq('contact_id', sd.contact_id)
      .eq('wizard_type', 'formation')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const wpData = (wp?.data ?? null) as Record<string, unknown> | null
    const s = wpData?.state_of_formation ?? wpData?.state_of_incorporation
    formationState = typeof s === 'string' && s.trim() ? s.trim() : null
  }

  // Load the client's name for ANY contact-linked SD to surface as a separate
  // "Contact" row in the Overview (COMPANY is left untouched — it's the company,
  // not the contact). Contact-scoped flows (in-flight Company Formation, ITIN)
  // have no account/company_name; account-scoped SDs that also carry a contact_id
  // now show both rows. The info panel renders the row only when contact_name is set.
  let contactName: string | null = null
  if (sd.contact_id) {
    const { data: contact } = await supabaseAdmin
      .from('contacts')
      .select('full_name')
      .eq('id', sd.contact_id)
      .maybeSingle()
    contactName = (contact?.full_name as string | null) ?? null
  }

  const account: WorkspaceAccount = {
    id: (accountRow?.id as string) ?? sd.account_id ?? '',
    company_name: (accountRow?.company_name as string | null) ?? null,
    state_of_formation: (accountRow?.state_of_formation as string | null) ?? formationState,
    annual_report_due_date: (accountRow?.annual_report_due_date as string | null) ?? null,
    ra_renewal_date: (accountRow?.ra_renewal_date as string | null) ?? null,
  }

  const serviceDelivery: WorkspaceServiceDelivery = {
    id: sd.id,
    service_type: sd.service_type,
    stage: sd.stage ?? null,
    stage_order: sd.stage_order ?? null,
    status: sd.status ?? null,
    assigned_to: sd.assigned_to ?? null,
    due_date: sd.due_date ?? null,
    stage_entered_at: sd.stage_entered_at ?? null,
    account_id: sd.account_id ?? '',
    contact_name: contactName,
    current_client_label: currentStageRow?.client_label ?? null,
    shipping_courier: (shipRow?.shipping_courier as string | null) ?? null,
    shipping_tracking_number: (shipRow?.shipping_tracking_number as string | null) ?? null,
    shipping_submitted_at: (shipRow?.shipping_submitted_at as string | null) ?? null,
  }

  const stepperStages: StepperStage[] = stages.map((s) => ({
    stage_name: s.stage_name,
    stage_order: s.stage_order,
    icon: s.icon,
    client_label: s.client_label,
  }))

  // 2nd installment invoice — only on the Tax Return "Awaiting 2nd Payment"
  // stage, where staff need to see the invoice the client must pay. Created by
  // the annual-installments cron in `payments` (payment_category='installment_2'
  // for the current calendar year). Scoped to this stage so no other stage/flow
  // pays the extra query.
  let secondInstallment: WorkspaceInvoice | null = null
  if (sd.service_type === 'Tax Return' && sd.stage === 'Awaiting 2nd Payment' && sd.account_id) {
    const { data: inv } = await supabaseAdmin
      .from('payments')
      .select('id, invoice_number, invoice_status, status, amount, amount_currency, due_date, paid_date')
      .eq('account_id', sd.account_id)
      .eq('payment_category', 'installment_2')
      .eq('year', new Date().getFullYear())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (inv) {
      secondInstallment = {
        id: inv.id as string,
        invoice_number: (inv.invoice_number as string | null) ?? null,
        invoice_status: (inv.invoice_status as string | null) ?? null,
        amount: (inv.amount as number | null) ?? null,
        currency: (inv.amount_currency as string | null) ?? null,
        due_date: (inv.due_date as string | null) ?? null,
        paid_date: (inv.paid_date as string | null) ?? null,
        is_paid: inv.paid_date != null || inv.status === 'Paid',
      }
    }
  }

  // Purchase Origin (ITIN only) — where this ITIN came from: the offer/contract
  // it was sold under + the invoice. ITIN SDs are contact-scoped, so the offer is
  // matched by contact_id OR via the contact's originating lead (offers.lead_id);
  // the invoice is the contact's most recent payment.
  let itinOrigin: ItinOrigin | null = null
  let itinContractUrl: string | null = null
  if (sd.service_type === 'ITIN' && sd.contact_id) {
    const { data: leadRows } = await supabaseAdmin
      .from('leads')
      .select('id')
      .eq('converted_to_contact_id', sd.contact_id)
    const leadIds = (leadRows ?? []).map((l) => l.id as string)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let offerQ = (supabaseAdmin as any)
      .from('offers')
      .select('token, contract_type, bundled_pipelines, status, created_at')
    offerQ = leadIds.length
      ? offerQ.or(`contact_id.eq.${sd.contact_id},lead_id.in.(${leadIds.join(',')})`)
      : offerQ.eq('contact_id', sd.contact_id)
    const { data: offer } = await offerQ.order('created_at', { ascending: false }).limit(1).maybeSingle()

    const { data: pay } = await supabaseAdmin
      .from('payments')
      .select('invoice_number, amount, amount_currency, status, paid_date, created_at')
      .eq('contact_id', sd.contact_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    itinOrigin = {
      offer: offer
        ? {
            token: (offer.token as string | null) ?? null,
            bundled: Array.isArray(offer.bundled_pipelines) && offer.bundled_pipelines.length > 0,
            contractType: (offer.contract_type as string | null) ?? null,
            status: (offer.status as string | null) ?? null,
          }
        : null,
      invoice: pay
        ? {
            invoice_number: (pay.invoice_number as string | null) ?? null,
            amount: (pay.amount as number | null) ?? null,
            currency: (pay.amount_currency as string | null) ?? null,
            paid: pay.status === 'Paid' || pay.paid_date != null,
            status: (pay.status as string | null) ?? null,
          }
        : null,
    }
    itinContractUrl = offer?.token ? `${APP_BASE_URL}/offer/${offer.token}?preview=td` : null
  }

  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto">
      {/* Back link */}
      {account.id && (
        <Link
          href={`/accounts/${account.id}`}
          className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-800 mb-4"
        >
          <ArrowLeft className="h-4 w-4" />
          {account.company_name ?? 'Account'}
        </Link>
      )}

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-zinc-900">
          {serviceDelivery.service_type}
          {year ? <span className="text-zinc-400"> {year}</span> : null}
        </h1>
        <p className="text-sm text-zinc-500 mt-0.5">
          {account.company_name ?? '—'}
          {serviceDelivery.status && (
            <span className="ml-2 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-600">
              {serviceDelivery.status}
            </span>
          )}
        </p>
      </div>

      {/* Purchase Origin — ITIN only, above the stepper */}
      {itinOrigin && <ItinOriginCard origin={itinOrigin} contractUrl={itinContractUrl} />}

      {/* Company Created milestone — Company Formation at "Articles Received" */}
      {companyCreatedName && (
        <div className="mb-6 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
          <span className="text-lg leading-none">✅</span>
          <span className="text-sm font-semibold text-emerald-800">Company Created — {companyCreatedName}</span>
        </div>
      )}

      {/* Stage stepper */}
      <div className="mb-6 overflow-x-auto pb-1">
        <StageStepper
          stages={stepperStages}
          currentStage={serviceDelivery.stage}
          serviceDeliveryId={serviceDelivery.id}
        />
      </div>

      {/* Stage content from stage_layout */}
      <StageRenderer layout={layout} serviceDelivery={serviceDelivery} account={account} secondInstallment={secondInstallment} />

      {/* Go Back — every stage except the first */}
      {previousStageRow && (
        <GoBackButton
          serviceDeliveryId={serviceDelivery.id}
          previousStageLabel={previousStageRow.client_label ?? previousStageRow.stage_name}
        />
      )}
    </div>
  )
}
