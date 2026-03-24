import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import {
  ArrowLeft, User, Mail, Phone, Globe, MessageSquare,
  Calendar, Tag, ExternalLink, FileText, Clock,
} from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { LeadDetailActions } from '@/components/leads/lead-detail-actions'

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
  'Sent': 'bg-blue-100 text-blue-700',
  'Viewed': 'bg-amber-100 text-amber-700',
  'Accepted': 'bg-emerald-100 text-emerald-700',
  'Rejected': 'bg-red-100 text-red-700',
}

function formatDate(d: string | null): string {
  if (!d) return '\u2014'
  try {
    return format(parseISO(d), 'dd/MM/yyyy')
  } catch {
    return d
  }
}

function formatCurrency(amount: number | null, currency?: string | null): string {
  if (amount == null) return '\u2014'
  const c = currency === 'EUR' ? '\u20AC' : '$'
  return `${c}${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export default async function LeadDetailPage({ params }: { params: { id: string } }) {
  const supabase = createClient()

  // Fetch lead with all fields
  const { data: lead } = await supabase
    .from('leads')
    .select('*')
    .eq('id', params.id)
    .single()

  if (!lead) notFound()

  // Fetch pending activation for this lead
  const { data: activation } = await supabase
    .from('pending_activations')
    .select('id, status, amount, currency, payment_method, created_at')
    .eq('lead_id', params.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const hasOffer = !!(lead.offer_status || lead.offer_link || lead.offer_year1_amount)
  const services: string[] = Array.isArray(lead.offer_services) ? lead.offer_services : []
  const optionalServices: string[] = Array.isArray(lead.offer_optional_services) ? lead.offer_optional_services : []

  return (
    <div className="p-6 lg:p-8 max-w-5xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="flex items-center gap-4">
          <Link
            href="/leads"
            className="p-2 rounded-lg hover:bg-zinc-100 transition-colors"
          >
            <ArrowLeft className="h-5 w-5 text-zinc-600" />
          </Link>
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

        {/* Register Payment button */}
        <LeadDetailActions
          leadId={lead.id}
          leadName={lead.full_name}
          hasActivation={!!activation}
          activationStatus={activation?.status ?? null}
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
                  <a href={`mailto:${lead.email}`} className="text-blue-600 hover:underline">
                    {lead.email}
                  </a>
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
              <dd className="font-medium">{lead.referrer_name ?? '\u2014'}</dd>
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
                {lead.status ? (
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[lead.status] ?? 'bg-zinc-100'}`}>
                    {lead.status}
                  </span>
                ) : '\u2014'}
              </dd>
            </div>
            {lead.reason && (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Reason</dt>
                <dd className="font-medium">{lead.reason}</dd>
              </div>
            )}
          </dl>
        </div>

        {/* Offer Details */}
        {hasOffer && (
          <div className="bg-white rounded-lg border p-5 md:col-span-2">
            <h2 className="text-sm font-semibold text-zinc-900 mb-4 flex items-center gap-2">
              <FileText className="h-4 w-4" />
              Offer Details
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {lead.offer_status && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Offer Status</p>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${OFFER_STATUS_COLORS[lead.offer_status] ?? 'bg-zinc-100'}`}>
                    {lead.offer_status}
                  </span>
                </div>
              )}
              {lead.offer_year1_amount != null && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Year 1 Amount</p>
                  <p className="text-sm font-semibold">
                    {formatCurrency(lead.offer_year1_amount, lead.offer_year1_currency)}
                  </p>
                </div>
              )}
              {lead.offer_annual_amount != null && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Annual Amount</p>
                  <p className="text-sm font-semibold">
                    {formatCurrency(lead.offer_annual_amount, lead.offer_annual_currency)}
                  </p>
                </div>
              )}
              {lead.offer_date && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Offer Date</p>
                  <p className="text-sm font-medium">{formatDate(lead.offer_date)}</p>
                </div>
              )}
              {lead.offer_link && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Offer Link</p>
                  <a
                    href={lead.offer_link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
                  >
                    Open offer <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              )}
            </div>

            {/* Services lists */}
            {services.length > 0 && (
              <div className="mt-4">
                <p className="text-xs text-muted-foreground mb-2">Services</p>
                <div className="flex flex-wrap gap-1.5">
                  {services.map((s) => (
                    <span key={s} className="text-xs px-2 py-1 rounded bg-blue-50 text-blue-700 font-medium">
                      {s}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {optionalServices.length > 0 && (
              <div className="mt-3">
                <p className="text-xs text-muted-foreground mb-2">Optional Services</p>
                <div className="flex flex-wrap gap-1.5">
                  {optionalServices.map((s) => (
                    <span key={s} className="text-xs px-2 py-1 rounded bg-zinc-100 text-zinc-600 font-medium">
                      {s}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {lead.offer_notes && (
              <div className="mt-4">
                <p className="text-xs text-muted-foreground mb-1">Offer Notes</p>
                <p className="text-sm text-zinc-700">{lead.offer_notes}</p>
              </div>
            )}
          </div>
        )}

        {/* Activation Info */}
        {activation && (
          <div className="bg-white rounded-lg border p-5 md:col-span-2">
            <h2 className="text-sm font-semibold text-zinc-900 mb-4 flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Pending Activation
            </h2>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <p className="text-xs text-muted-foreground mb-1">Status</p>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                  activation.status === 'activated'
                    ? 'bg-emerald-100 text-emerald-700'
                    : activation.status === 'pending_confirmation'
                      ? 'bg-amber-100 text-amber-700'
                      : 'bg-blue-100 text-blue-700'
                }`}>
                  {activation.status}
                </span>
              </div>
              {activation.amount != null && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Amount</p>
                  <p className="text-sm font-semibold">
                    {formatCurrency(activation.amount, activation.currency)}
                  </p>
                </div>
              )}
              {activation.payment_method && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Payment Method</p>
                  <p className="text-sm font-medium">{activation.payment_method}</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Notes */}
        {lead.notes && (
          <div className="bg-white rounded-lg border p-5 md:col-span-2">
            <h2 className="text-sm font-semibold text-zinc-900 mb-3 flex items-center gap-2">
              <MessageSquare className="h-4 w-4" />
              Notes
            </h2>
            <div className="max-h-64 overflow-y-auto rounded-lg bg-zinc-50 p-4">
              <pre className="text-sm text-zinc-700 whitespace-pre-wrap font-sans leading-relaxed">
                {lead.notes}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
