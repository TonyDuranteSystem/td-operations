import { createClient } from '@/lib/supabase/server'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, MessageSquare, Layers } from 'lucide-react'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { getTeammateScopeOrNull } from '@/lib/portal/team/gate'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getLocale } from '@/lib/portal/i18n'
import { FlowProgressTracker } from '@/components/portal/flow-progress-tracker'
import { FlowStageJourney, type ShippingCard } from '@/components/portal/flow-stage-journey'
import { DocumentList } from '@/components/portal/document-list'
import { buildFlowSteps, buildJourneySteps, type FlowStageRow } from '@/lib/flows/flow-progress'
import { deriveFlowYear, buildFlowTopic, ALL_FLOW_TYPES, CONTACT_FLOW_TYPES } from '@/lib/flows/resolve-flows'
import { isClientSafeFlowDoc } from '@/lib/flows/flow-doc-visibility'

export const dynamic = 'force-dynamic'

const CATEGORY_LABELS: Record<number, string> = {
  1: 'Company', 2: 'Contacts', 3: 'Tax', 4: 'Banking', 5: 'Correspondence',
}

/**
 * Print/sign/mail card shown on the ITIN "Client Signing" stage. The mailing
 * destination is TD's document-receiving office (Seminole) — NOT the CMRA
 * business address. Keep in sync with the itin_prepare_documents email
 * (lib/mcp/tools/itin-form.ts) and itin-approve-and-send.ts.
 */
function buildItinShippingCard(
  locale: 'en' | 'it',
  documents: { id: string; file_name: string }[],
): ShippingCard {
  const addressLines = ['Tony Durante LLC', '11125 Park Blvd, Suite 104-153', 'Seminole, FL 33772', 'United States']
  if (locale === 'it') {
    return {
      stageName: 'Client Signing',
      title: 'Stampa, firma e spedisci i documenti',
      intro: 'Stampa i documenti, firmali a inchiostro e spediscili a:',
      addressLines,
      checklist: [
        '2 copie firmate del Form W-7',
        '2 copie firmate del Form 1040-NR (con Schedule OI)',
        '2 copie a colori del passaporto (pagina dati + pagina firma)',
      ],
      tracking: 'Usa un corriere tracciabile (FedEx, DHL, UPS) e condividi con noi il numero di tracking.',
      documentsHeading: 'I tuoi documenti da stampare:',
      downloadLabel: 'Scarica',
      documents,
    }
  }
  return {
    stageName: 'Client Signing',
    title: 'Print, sign & mail your documents',
    intro: 'Print these documents, sign them with wet ink, and mail to:',
    addressLines,
    checklist: [
      '2× signed Form W-7',
      '2× signed Form 1040-NR (with Schedule OI)',
      '2× color copies of your passport (data page + signature page)',
    ],
    tracking: 'Use a trackable shipping method (FedEx, DHL, UPS) and share the tracking number with us.',
    documentsHeading: 'Your documents to print:',
    downloadLabel: 'Download',
    documents,
  }
}

/**
 * Client-facing flow detail page (`/portal/flows/[id]`, [id] = service_delivery_id).
 *
 * Shows ONE recurring flow's full client-facing journey: a progress stepper
 * (client_label per stage), the curated client-safe documents for that flow, and
 * the flow's chat messages. Read-only — the client never advances stages here.
 *
 * Access is strictly gated: the SD must belong to an account the signed-in
 * client (or teammate) can access, or be the contact's own contact-scoped SD.
 * Otherwise notFound() — a client must never open another account's flow.
 */
export default async function PortalFlowDetailPage({ params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')

  const locale = getLocale(user)

  // Load the SD.
  const { data: sd } = await supabaseAdmin
    .from('service_deliveries')
    .select('id, service_type, service_name, stage, status, account_id, contact_id, due_date, stage_entered_at, created_at')
    .eq('id', params.id)
    .maybeSingle()

  if (!sd || !sd.service_type || !(ALL_FLOW_TYPES as readonly string[]).includes(sd.service_type)) {
    notFound()
  }

  // ── Access control ──
  const contactId = getClientContactId(user)
  let allowed = false
  if (contactId) {
    if (sd.contact_id && sd.contact_id === contactId) {
      allowed = true
    } else if (sd.account_id) {
      const accountIds = await getClientAccountIds(contactId)
      allowed = accountIds.includes(sd.account_id)
    }
  } else {
    // Teammate (Portal Team Access) — scoped to ONE account, requires 'documents'.
    const tmAccountId = await getTeammateScopeOrNull(user, 'documents')
    allowed = !!tmAccountId && !!sd.account_id && sd.account_id === tmAccountId
  }
  if (!allowed) notFound()

  // ── Flow progress ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: stageRows } = await (supabaseAdmin as any)
    .from('pipeline_stages')
    .select('stage_name, stage_order, client_label, client_label_it, client_description, icon')
    .eq('service_type', sd.service_type)

  const stages: FlowStageRow[] = ((stageRows ?? []) as Array<Record<string, unknown>>).map(r => ({
    stage_name: r.stage_name as string,
    stage_order: (r.stage_order as number | null) ?? 0,
    client_label: (r.client_label as string | null) ?? null,
    client_label_it: (r.client_label_it as string | null) ?? null,
    client_description: (r.client_description as string | null) ?? null,
    icon: (r.icon as string | null) ?? null,
  }))

  // Contact-scoped flows (ITIN) get the rich, clickable per-stage journey driven
  // by client_description; account flows keep the compact horizontal stepper.
  const isContactFlow = (CONTACT_FLOW_TYPES as readonly string[]).includes(sd.service_type)
  const steps = isContactFlow ? null : buildFlowSteps(stages, sd.stage ?? null, locale)
  const journey = isContactFlow ? buildJourneySteps(stages, sd.stage ?? null, locale) : null
  const year = deriveFlowYear(sd)
  const title = buildFlowTopic(sd.service_type, year) || sd.service_name || sd.service_type || 'Service'

  // ── Curated client-safe documents for this flow ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: docData } = await (supabaseAdmin as any)
    .from('documents')
    .select('id, file_name, document_type_name, category, drive_file_id, processed_at, created_at, flow_stage, portal_visible')
    .eq('service_delivery_id', sd.id)
    .order('created_at', { ascending: false })
    .limit(100)
  const docs = ((docData ?? []) as Array<{
    id: string; file_name: string; document_type_name: string | null; category: number | null
    drive_file_id: string | null; processed_at: string | null; created_at: string
    flow_stage: string | null; portal_visible: boolean | null
  }>).filter(d => isClientSafeFlowDoc(sd.service_type, d.flow_stage, d.portal_visible))

  // ITIN "Client Signing" card embeds the actual prepared documents (W-7 /
  // 1040-NR / Schedule OI) as download links — the SD-linked client-safe docs
  // above are exactly those generated forms.
  const shipping: ShippingCard | null =
    sd.service_type === 'ITIN'
      ? buildItinShippingCard(locale, docs.map(d => ({ id: d.id, file_name: d.file_name })))
      : null

  // ── Flow chat messages (read-only) — same scoping as the portal chat client
  // view: never show soft-deleted rows or internal chat-event notes. ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: msgData } = await (supabaseAdmin as any)
    .from('portal_messages')
    .select('id, sender_type, sender_name, message, created_at')
    .eq('service_delivery_id', sd.id)
    .is('deleted_at', null)
    .not('message', 'ilike', '%<!-- chat-event:%')
    .order('created_at', { ascending: true })
    .limit(100)
  const messages = (msgData ?? []) as Array<{
    id: string; sender_type: string; sender_name: string | null; message: string; created_at: string | null
  }>

  const teamLabel = locale === 'it' ? 'Team Tony Durante' : 'Tony Durante Team'
  const youLabel = locale === 'it' ? 'Tu' : 'You'

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-3xl mx-auto space-y-6">
      <Link
        href="/portal"
        className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-800"
      >
        <ArrowLeft className="h-4 w-4" />
        {locale === 'it' ? 'Torna alla dashboard' : 'Back to dashboard'}
      </Link>

      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-900">{title}</h1>
        {sd.status === 'completed' && (
          <span className="inline-block mt-1 text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">
            {locale === 'it' ? 'Completato' : 'Completed'}
          </span>
        )}
      </div>

      {/* Progress — rich clickable journey for contact flows (ITIN), the compact
          stepper for account flows, or a neutral state when neither applies. */}
      {journey && journey.length > 0 ? (
        <FlowStageJourney
          title={locale === 'it' ? 'Avanzamento' : 'Progress'}
          steps={journey}
          shipping={shipping}
        />
      ) : steps ? (
        <FlowProgressTracker title={locale === 'it' ? 'Avanzamento' : 'Progress'} steps={steps} />
      ) : (
        <div className="bg-white rounded-xl border shadow-sm p-5">
          <span className="text-sm text-zinc-600">{locale === 'it' ? 'Servizio attivo' : 'Service active'}</span>
        </div>
      )}

      {/* Documents for this flow */}
      {docs.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Layers className="h-4 w-4 text-zinc-500" />
            <h2 className="text-sm font-semibold text-zinc-700">
              {locale === 'it' ? 'Documenti' : 'Documents'}
            </h2>
          </div>
          <DocumentList documents={docs} categoryLabels={CATEGORY_LABELS} locale={locale} />
        </div>
      )}

      {/* Flow messages (read-only) + link to full chat */}
      <div>
        <div className="flex items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-zinc-500" />
            <h2 className="text-sm font-semibold text-zinc-700">
              {locale === 'it' ? 'Messaggi' : 'Messages'}
            </h2>
          </div>
          <Link href="/portal/chat" className="text-xs text-blue-600 hover:text-blue-700 hover:underline">
            {locale === 'it' ? 'Apri chat →' : 'Open chat →'}
          </Link>
        </div>
        {messages.length === 0 ? (
          <div className="bg-white rounded-xl border shadow-sm p-5 text-sm text-zinc-500">
            {locale === 'it' ? 'Nessun messaggio per questo servizio.' : 'No messages for this service yet.'}
          </div>
        ) : (
          <div className="bg-white rounded-xl border shadow-sm divide-y">
            {messages.map(m => {
              const isAdmin = m.sender_type === 'admin'
              const who = isAdmin ? teamLabel : (m.sender_name || youLabel)
              return (
                <div key={m.id} className="p-4">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className={`text-xs font-medium ${isAdmin ? 'text-blue-700' : 'text-zinc-600'}`}>{who}</span>
                    {m.created_at && (
                      <span className="text-[11px] text-zinc-400">
                        {new Date(m.created_at).toLocaleString(locale === 'it' ? 'it-IT' : 'en-US', {
                          month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                        })}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-zinc-800 whitespace-pre-wrap break-words">{m.message}</p>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
