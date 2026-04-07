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
import { LeadNotesEditor } from './components/lead-notes-editor'

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
  'viewed': 'bg-amber-100 text-amber-700',
  'signed': 'bg-indigo-100 text-indigo-700',
  'completed': 'bg-emerald-100 text-emerald-700',
  'expired': 'bg-red-100 text-red-600',
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

  // Source of truth: offers table
  const { data: offer } = await supabase
    .from('offers')
    .select('token, status, contract_type, language, offer_date, selected_services, bundled_pipelines, cost_summary, referrer_name, referrer_type, view_count, viewed_at, created_at')
    .eq('lead_id', params.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  // Source of truth: pending_activations table
  const { data: activation } = await supabase
    .from('pending_activations')
    .select('id, status, amount, currency, payment_method, payment_confirmed_at, signed_at, notes, created_at')
    .eq('lead_id', params.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

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
            <div className="flex justify-between">
              <dt className="text-muted-foreground flex items-center gap-1.5">
                <Mail className="h-3.5 w-3.5" /> Email
              </dt>
              <dd className="font-medium">
                {lead.email ? (
                  <a href={`mailto:${lead.email}`} className="text-blue-600 hover:underline">{lead.email}</a>
                ) : '\u2014'}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground flex items-center gap-1.5">
                <Phone className="h-3.5 w-3.5" /> Phone
              </dt>
              <dd className="font-medium">{lead.phone ?? '\u2014'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground flex items-center gap-1.5">
                <Globe className="h-3.5 w-3.5" /> Language
              </dt>
              <dd className="font-medium">{lead.language ?? '\u2014'}</dd>
            </div>
            <div className="flex justify-between">
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
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Source</dt>
              <dd className="font-medium">{lead.source ?? '\u2014'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Referrer</dt>
              <dd className="font-medium">
                {offer?.referrer_name
                  ? `${offer.referrer_name}${offer.referrer_type ? ` (${offer.referrer_type})` : ''}`
                  : lead.referrer_name ?? '\u2014'}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground flex items-center gap-1.5">
                <Calendar className="h-3.5 w-3.5" /> Call Date
              </dt>
              <dd className="font-medium">{formatDate(lead.call_date)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Status</dt>
              <dd>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[lead.status] ?? 'bg-zinc-100'}`}>
                  {lead.status ?? '\u2014'}
                </span>
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

        {/* Notes (editable) */}
        <LeadNotesEditor leadId={lead.id} notes={lead.notes ?? ''} />
      </div>
    </div>
  )
}
