import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { notFound } from 'next/navigation'
import { BackButton } from '@/components/ui/back-button'
import {
  User, Mail, Phone, Globe, MessageSquare,
  Calendar, Tag, ExternalLink, FileText, CreditCard, CheckCircle2,
} from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { APP_BASE_URL } from '@/lib/config'
import { isDashboardUser } from '@/lib/auth'
import { LeadActions } from './components/lead-actions'
import { LeadLifecycleBar } from './components/lead-lifecycle-bar'
import { LeadNotesEditor } from './components/lead-notes-editor'
import { CallSummaryCard } from './components/call-summary-card'
import { EditableField } from './components/editable-field'
import { LifecycleTimeline } from '@/components/lifecycle/timeline'
import { assembleTimeline } from '@/lib/lifecycle-timeline'

const STATUS_COLORS: Record<string, string> = {
  'New': 'bg-blue-100 text-blue-700',
  'Call Scheduled': 'bg-cyan-100 text-cyan-700',
  'Call Done': 'bg-violet-100 text-violet-700',
  'Contacted': 'bg-amber-100 text-amber-700',
  'Qualified': 'bg-indigo-100 text-indigo-700',
  'Offer Sent': 'bg-orange-100 text-orange-700',
  'Negotiating': 'bg-pink-100 text-pink-700',
  'Converted': 'bg-emerald-100 text-emerald-700',
  'Lost': 'bg-zinc-100 text-zinc-500',
  'Suspended': 'bg-yellow-100 text-yellow-700',
}

const OFFER_STATUS_COLORS: Record<string, string> = {
  'draft': 'bg-zinc-100 text-zinc-600',
  'sent': 'bg-blue-100 text-blue-700',
  'published': 'bg-blue-100 text-blue-700',
  'viewed': 'bg-amber-100 text-amber-700',
  'signed': 'bg-indigo-100 text-indigo-700',
  'completed': 'bg-emerald-100 text-emerald-700',
  'expired': 'bg-red-100 text-red-600',
  'under_discussion': 'bg-amber-100 text-amber-800',
  'superseded': 'bg-zinc-100 text-zinc-500',
}

const ACTIVATION_STATUS_COLORS: Record<string, string> = {
  'awaiting_payment': 'bg-zinc-100 text-zinc-600',
  'payment_confirmed': 'bg-blue-100 text-blue-700',
  'pending_confirmation': 'bg-amber-100 text-amber-700',
  'activated': 'bg-emerald-100 text-emerald-700',
}

function formatDate(d: string | null): string {
  if (!d) return '\u2014'
  try {
    return format(parseISO(d), 'MMM d, yyyy')
  } catch {
    return d
  }
}

function formatCurrency(amount: number | null, currency?: string | null): string {
  if (amount == null) return '\u2014'
  const c = currency === 'EUR' ? '\u20AC' : '$'
  return `${c}${amount.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
}

export default async function LeadDetailPage({ params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const admin = user ? isDashboardUser(user) : false

  const { data: lead } = await supabase
    .from('leads')
    .select('*')
    .eq('id', params.id)
    .single()

  if (!lead) notFound()

  // Source of truth: offers table — fetch ALL versions for this lead
  const { data: allOffers } = await supabase
    .from('offers')
    .select('token, status, contract_type, language, offer_date, selected_services, bundled_pipelines, cost_summary, referrer_name, referrer_type, view_count, viewed_at, created_at, admin_notes, version, superseded_by')
    .eq('lead_id', params.id)
    .order('version', { ascending: false })
    .order('created_at', { ascending: false })

  // Current offer = highest version that is NOT superseded (or fallback to highest version)
  const offer = allOffers?.find(o => o.status !== 'superseded') ?? allOffers?.[0] ?? null
  const previousOffers = (allOffers ?? []).filter(o => o.token !== offer?.token)

  // Source of truth: pending_activations table
  const { data: activation } = await supabase
    .from('pending_activations')
    .select('id, status, amount, currency, payment_method, payment_confirmed_at, signed_at, notes, created_at')
    .eq('lead_id', params.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  // Fetch linked Circleback call summary
  let callSummary = null
  if (lead.circleback_call_id) {
    const { data } = await supabaseAdmin
      .from('call_summaries')
      .select('id, meeting_name, duration_seconds, attendees, notes, action_items, recording_url, created_at')
      .eq('id', lead.circleback_call_id)
      .single()
    callSummary = data
  }

  // Fetch timeline data: email tracking + contracts (for signed_at)
  const offerTokens = (allOffers ?? []).map(o => o.token)
  const [emailTrackingResult, contractsResult] = await Promise.all([
    supabase
      .from('email_tracking')
      .select('id, subject, created_at, first_opened_at')
      .eq('lead_id', params.id)
      .order('created_at', { ascending: true }),
    offerTokens.length > 0
      ? supabase
          .from('contracts')
          .select('offer_token, signed_at')
          .in('offer_token', offerTokens)
      : Promise.resolve({ data: [] }),
  ])

  const timelineEvents = assembleTimeline({
    lead: { created_at: lead.created_at, status: lead.status, call_date: lead.call_date, converted_to_contact_id: lead.converted_to_contact_id, updated_at: lead.updated_at },
    offers: (allOffers ?? []).map(o => ({ token: o.token, status: o.status, created_at: o.created_at, viewed_at: o.viewed_at, version: o.version, superseded_by: o.superseded_by })),
    callSummary: callSummary ? { created_at: callSummary.created_at, meeting_name: callSummary.meeting_name, duration_seconds: callSummary.duration_seconds } : null,
    emailTracking: emailTrackingResult.data ?? [],
    contracts: contractsResult.data ?? [],
    activations: activation ? [{ id: activation.id, status: activation.status, created_at: activation.created_at, payment_confirmed_at: activation.payment_confirmed_at, amount: activation.amount, currency: activation.currency }] : [],
  })

  // Check for portal user (admin-only, for delete button visibility)
  let hasPortalUser = false
  if (admin && lead.email) {
    const { data: list } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
    hasPortalUser = (list?.users ?? []).some(
      (u: { email?: string }) => u.email?.toLowerCase() === lead.email.toLowerCase()
    )
  }

  const selectedServices: string[] = Array.isArray(offer?.selected_services) ? offer.selected_services : []
  const bundledPipelines: string[] = Array.isArray(offer?.bundled_pipelines) ? offer.bundled_pipelines : []

  return (
    <div className="p-6 lg:p-8 max-w-5xl">
      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
        <BackButton />
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{lead.full_name}</h1>
            {lead.status && (
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[lead.status] ?? 'bg-zinc-100'}`}>
                {lead.status}
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            Lead created {formatDate(lead.created_at)}
          </p>
        </div>
      </div>

      {/* Lifecycle Bar */}
      <LeadLifecycleBar
        leadStatus={lead.status}
        callDate={lead.call_date}
        offerStatus={offer?.status ?? null}
        offerViewedAt={offer?.viewed_at ?? null}
        signedAt={
          (contractsResult.data ?? []).find(
            (c: { offer_token: string; signed_at: string | null }) => c.offer_token === offer?.token
          )?.signed_at
          ?? activation?.signed_at
          ?? null
        }
        activationStatus={activation?.status ?? null}
        paymentConfirmedAt={activation?.payment_confirmed_at ?? null}
        convertedToContactId={lead.converted_to_contact_id}
      />

      {/* Admin Actions */}
      <div className="mb-6">
        <LeadActions
          leadId={lead.id}
          leadName={lead.full_name}
          leadEmail={lead.email}
          leadStatus={lead.status}
          leadLanguage={lead.language}
          leadReferrer={offer?.referrer_name || lead.referrer_name}
          leadReferrerType={offer?.referrer_type || null}
          contactId={lead.converted_to_contact_id}
          offer={offer ? {
            token: offer.token,
            status: offer.status,
            contract_type: offer.contract_type,
            bundled_pipelines: bundledPipelines,
            cost_summary: offer.cost_summary as Array<{ label: string; total?: string; items?: Array<{ name: string; price: string }> }> | null,
          } : null}
          activation={activation ? {
            id: activation.id,
            status: activation.status,
          } : null}
          isAdmin={admin}
          hasPortalUser={hasPortalUser}
        />
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Contact Information */}
        <div className="bg-white rounded-lg border p-5">
          <h2 className="text-sm font-semibold text-zinc-900 mb-4 flex items-center gap-2">
            <User className="h-4 w-4" />
            Contact Information
          </h2>
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between items-center">
              <dt className="text-muted-foreground flex items-center gap-1.5">
                <User className="h-3.5 w-3.5" /> Name
              </dt>
              <dd>
                <EditableField leadId={lead.id} field="full_name" value={lead.full_name} />
              </dd>
            </div>
            <div className="flex justify-between items-center">
              <dt className="text-muted-foreground flex items-center gap-1.5">
                <Mail className="h-3.5 w-3.5" /> Email
              </dt>
              <dd>
                <EditableField leadId={lead.id} field="email" value={lead.email} warning="Affects matching" />
              </dd>
            </div>
            <div className="flex justify-between items-center">
              <dt className="text-muted-foreground flex items-center gap-1.5">
                <Phone className="h-3.5 w-3.5" /> Phone
              </dt>
              <dd>
                <EditableField leadId={lead.id} field="phone" value={lead.phone} placeholder="+1..." />
              </dd>
            </div>
            <div className="flex justify-between items-center">
              <dt className="text-muted-foreground flex items-center gap-1.5">
                <Globe className="h-3.5 w-3.5" /> Language
              </dt>
              <dd>
                <EditableField
                  leadId={lead.id}
                  field="language"
                  value={lead.language}
                  type="select"
                  options={[
                    { value: 'Italian', label: 'Italian' },
                    { value: 'English', label: 'English' },
                  ]}
                />
              </dd>
            </div>
            <div className="flex justify-between items-center">
              <dt className="text-muted-foreground flex items-center gap-1.5">
                <MessageSquare className="h-3.5 w-3.5" /> Channel
              </dt>
              <dd className="font-medium">{lead.channel ?? '\u2014'}</dd>
            </div>
          </dl>
        </div>

        {/* Source & Status */}
        <div className="bg-white rounded-lg border p-5">
          <h2 className="text-sm font-semibold text-zinc-900 mb-4 flex items-center gap-2">
            <Tag className="h-4 w-4" />
            Source & Status
          </h2>
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between items-center">
              <dt className="text-muted-foreground">Source</dt>
              <dd>
                <EditableField
                  leadId={lead.id}
                  field="source"
                  value={lead.source}
                  type="select"
                  options={[
                    { value: 'Calendly', label: 'Calendly' },
                    { value: 'Referral', label: 'Referral' },
                    { value: 'Website', label: 'Website' },
                    { value: 'Social', label: 'Social' },
                    { value: 'Email', label: 'Email' },
                    { value: 'Other', label: 'Other' },
                  ]}
                />
              </dd>
            </div>
            <div className="flex justify-between items-center">
              <dt className="text-muted-foreground">Referrer</dt>
              <dd>
                <EditableField leadId={lead.id} field="referrer_name" value={lead.referrer_name} clearable placeholder="Name" />
                {offer?.referrer_name && offer.referrer_name !== lead.referrer_name && (
                  <span className="text-[10px] text-zinc-400 block mt-0.5">
                    Offer: {offer.referrer_name}{offer.referrer_type ? ` (${offer.referrer_type})` : ''}
                  </span>
                )}
              </dd>
            </div>
            <div className="flex justify-between items-center">
              <dt className="text-muted-foreground flex items-center gap-1.5">
                <Calendar className="h-3.5 w-3.5" /> Call Date
              </dt>
              <dd>
                <EditableField leadId={lead.id} field="call_date" value={lead.call_date} type="date" />
              </dd>
            </div>
            <div className="flex justify-between items-center">
              <dt className="text-muted-foreground">Status</dt>
              <dd>
                <EditableField
                  leadId={lead.id}
                  field="status"
                  value={lead.status}
                  type="select"
                  options={[
                    { value: 'New', label: 'New' },
                    { value: 'Call Scheduled', label: 'Call Scheduled' },
                    { value: 'Call Done', label: 'Call Done' },
                    { value: 'Offer Sent', label: 'Offer Sent' },
                    { value: 'Negotiating', label: 'Negotiating' },
                    { value: 'Paid', label: 'Paid' },
                    { value: 'Converted', label: 'Converted' },
                    { value: 'Lost', label: 'Lost' },
                    { value: 'Suspended', label: 'Suspended' },
                  ]}
                />
              </dd>
            </div>
          </dl>
        </div>

        {/* Offer — from offers table */}
        {offer && (
          <div className="bg-white rounded-lg border p-5 md:col-span-2">
            <h2 className="text-sm font-semibold text-zinc-900 mb-4 flex items-center gap-2">
              <FileText className="h-4 w-4" />
              Offer
              {(offer.version ?? 1) > 1 && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">
                  v{offer.version}
                </span>
              )}
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <p className="text-xs text-muted-foreground mb-1">Status</p>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${OFFER_STATUS_COLORS[offer.status] ?? 'bg-zinc-100'}`}>
                  {offer.status}
                </span>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Contract Type</p>
                <p className="text-sm font-medium capitalize">{offer.contract_type ?? '\u2014'}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Offer Date</p>
                <p className="text-sm font-medium">{formatDate(offer.offer_date ?? offer.created_at)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Views</p>
                <p className="text-sm font-medium">{offer.view_count ?? 0}</p>
              </div>
            </div>

            {/* Cost Summary */}
            {Array.isArray(offer.cost_summary) && offer.cost_summary.length > 0 && (
              <div className="mt-4">
                <p className="text-xs text-muted-foreground mb-2">Cost Summary</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {(offer.cost_summary as Array<{ label: string; total: string; total_label?: string; items?: Array<{ name: string; price: string }> }>).map((section, i) => (
                    <div key={i} className="bg-zinc-50 rounded-lg p-3">
                      <p className="text-xs font-semibold text-zinc-700 mb-1">{section.label}</p>
                      {section.items?.map((item, j) => (
                        <div key={j} className="flex justify-between text-xs text-zinc-600">
                          <span>{item.name}</span>
                          <span className="font-medium">{item.price}</span>
                        </div>
                      ))}
                      <div className="flex justify-between text-sm font-semibold text-zinc-900 mt-1 pt-1 border-t border-zinc-200">
                        <span>Total</span>
                        <span>{section.total}</span>
                      </div>
                      {section.total_label && (
                        <p className="text-[10px] text-muted-foreground mt-0.5">{section.total_label}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Selected Services */}
            {selectedServices.length > 0 && (
              <div className="mt-4">
                <p className="text-xs text-muted-foreground mb-2">Selected Services</p>
                <div className="flex flex-wrap gap-1.5">
                  {selectedServices.map((s) => (
                    <span key={s} className="text-xs px-2 py-1 rounded bg-blue-50 text-blue-700 font-medium">{s}</span>
                  ))}
                </div>
              </div>
            )}

            {/* Bundled Pipelines */}
            {bundledPipelines.length > 0 && (
              <div className="mt-3">
                <p className="text-xs text-muted-foreground mb-2">Service Pipelines</p>
                <div className="flex flex-wrap gap-1.5">
                  {bundledPipelines.map((p) => (
                    <span key={p} className="text-xs px-2 py-1 rounded bg-indigo-50 text-indigo-700 font-medium">{p}</span>
                  ))}
                </div>
              </div>
            )}

            {offer.token && (
              <div className="mt-4">
                <a
                  href={`${APP_BASE_URL}/offer/${offer.token}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
                >
                  Open offer page <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            )}
          </div>
        )}

        {/* Offer Context (internal) */}
        {offer?.admin_notes && (
          <div className="bg-amber-50/50 rounded-lg border border-amber-200/50 p-5 md:col-span-2">
            <h2 className="text-sm font-semibold text-zinc-700 mb-2 flex items-center gap-2">
              <FileText className="h-4 w-4 text-amber-600" />
              Offer Context
              <span className="text-[10px] font-normal text-amber-600 bg-amber-100 px-1.5 py-0.5 rounded">internal — not visible to client</span>
            </h2>
            <pre className="text-sm text-zinc-700 whitespace-pre-wrap font-sans leading-relaxed max-h-48 overflow-y-auto">
              {offer.admin_notes}
            </pre>
          </div>
        )}

        {/* Offer Version History */}
        {previousOffers.length > 0 && (
          <div className="bg-white rounded-lg border p-5 md:col-span-2">
            <h2 className="text-sm font-semibold text-zinc-700 mb-3">
              Previous Versions ({previousOffers.length})
            </h2>
            <div className="space-y-2">
              {previousOffers.map(prev => {
                const statusColor: Record<string, string> = {
                  superseded: 'bg-zinc-100 text-zinc-500',
                  published: 'bg-blue-100 text-blue-700',
                  viewed: 'bg-amber-100 text-amber-700',
                  signed: 'bg-indigo-100 text-indigo-700',
                  completed: 'bg-emerald-100 text-emerald-700',
                }
                return (
                  <div key={prev.token} className="flex items-center justify-between p-3 rounded-lg bg-zinc-50">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">v{prev.version ?? 1}</span>
                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${statusColor[prev.status] ?? 'bg-zinc-100'}`}>
                          {prev.status}
                        </span>
                        <span className="text-xs text-muted-foreground">{formatDate(prev.offer_date ?? prev.created_at)}</span>
                      </div>
                    </div>
                    <a
                      href={`${APP_BASE_URL}/offer/${prev.token}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-blue-600 hover:underline flex items-center gap-1"
                    >
                      View <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Lifecycle — from pending_activations */}
        {activation && (
          <div className="bg-white rounded-lg border p-5 md:col-span-2">
            <h2 className="text-sm font-semibold text-zinc-900 mb-4 flex items-center gap-2">
              <CreditCard className="h-4 w-4" />
              Contract & Payment
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {/* Contract signed */}
              <div>
                <p className="text-xs text-muted-foreground mb-1">Contract Signed</p>
                {activation.signed_at ? (
                  <div className="flex items-center gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                    <p className="text-sm font-medium">{formatDate(activation.signed_at)}</p>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">\u2014</p>
                )}
              </div>

              {/* Payment status */}
              <div>
                <p className="text-xs text-muted-foreground mb-1">Payment Status</p>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${ACTIVATION_STATUS_COLORS[activation.status] ?? 'bg-zinc-100'}`}>
                  {activation.status}
                </span>
              </div>

              {/* Amount */}
              <div>
                <p className="text-xs text-muted-foreground mb-1">Amount Paid</p>
                <p className="text-sm font-semibold">{formatCurrency(activation.amount, activation.currency)}</p>
              </div>

              {/* Payment confirmed */}
              <div>
                <p className="text-xs text-muted-foreground mb-1">Payment Confirmed</p>
                {activation.payment_confirmed_at ? (
                  <div className="flex items-center gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                    <p className="text-sm font-medium">{formatDate(activation.payment_confirmed_at)}</p>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">\u2014</p>
                )}
              </div>
            </div>

            {activation.payment_method && (
              <p className="text-xs text-muted-foreground mt-3">
                Payment method: {activation.payment_method}
              </p>
            )}
            {activation.notes && (
              <p className="text-xs text-muted-foreground mt-1">{activation.notes}</p>
            )}
          </div>
        )}

        {/* Lifecycle Timeline */}
        <LifecycleTimeline events={timelineEvents} />

        {/* Call Summary (Circleback bridge) + Staff Call Notes */}
        <CallSummaryCard
          leadId={lead.id}
          leadEmail={lead.email}
          initialCall={callSummary}
          callNotes={lead.call_notes ?? null}
        />

        {/* Notes (editable) */}
        <LeadNotesEditor leadId={lead.id} notes={lead.notes ?? ''} />
      </div>
    </div>
  )
}
