import { LeadActionPanel } from '@/components/marketing/lead-action-panel'
import { PaymentLinkPanel, type PaymentLinkProps } from '@/components/marketing/payment-link-panel'
import { clientFlagText, eventText, formatWhen, prettyAnswer, prettyQuestion, stageLabel, telHref, type StageOption } from '@/lib/marketing/lead-view'
import type { LeadEventRow, LeadRow } from '@/lib/marketing/leads-read'
import { hasPermission, type MarketingPermission } from '@/lib/marketing/permissions'

interface Props {
  lead: LeadRow
  events: LeadEventRow[]
  stages: StageOption[]
  reasons: StageOption[]
  checklist: string[]
  permissions: readonly MarketingPermission[]
  isOwner: boolean
  myId: string
  /** where to go after Good / Not in target / Call back (the next lead in the call list); empty = stay on this lead */
  afterHref?: string
  /** the payment-link box; only given to people who may create payment links */
  paymentLink?: PaymentLinkProps
}

/** One lead, everything about it, with the buttons: used by the Leads screen and the Call list. A computer-width panel. Team-scoped by whoever loads it. */
export function LeadPane({ lead, events, stages, reasons, checklist, permissions, isOwner, myId, afterHref, paymentLink }: Props) {
  const claim = lead.claimed_by === null ? 'free' : lead.claimed_by === myId ? 'me' : 'other'
  const flag = clientFlagText(lead.existing_client)
  const tel = telHref(lead.phone)
  const where = [lead.campaign_name, lead.adset_name, lead.ad_name].filter(Boolean)
  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-white p-5">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-xl font-semibold">{lead.full_name || lead.email || lead.phone || 'Unnamed lead'}</h2>
          <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs">{stageLabel(stages, lead.status)}</span>
        </div>
        <div className="mt-3 grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
          {lead.phone && <p><span className="text-slate-500">Phone: </span>{tel ? <a className="font-medium underline" href={tel}>{lead.phone}</a> : lead.phone}</p>}
          {lead.email && <p><span className="text-slate-500">Email: </span><a className="underline" href={`mailto:${lead.email}`}>{lead.email}</a></p>}
          {(lead.city || lead.country) && <p><span className="text-slate-500">Place: </span>{[lead.city, lead.country].filter(Boolean).join(', ')}</p>}
          <p><span className="text-slate-500">Filled in: </span>{formatWhen(lead.meta_created_time ?? lead.received_at)}</p>
          <p><span className="text-slate-500">Picked by: </span>{lead.claimed_by === null ? 'nobody' : claim === 'me' ? 'you' : lead.claimed_by_label ?? 'a team member'}</p>
          {lead.callback_at && <p><span className="text-slate-500">Call back: </span><b>{formatWhen(lead.callback_at)}</b></p>}
          {lead.not_in_target_reason && <p><span className="text-slate-500">Not in target: </span>{reasons.find(r => r.key === lead.not_in_target_reason)?.label ?? lead.not_in_target_reason}</p>}
        </div>
        {flag && <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{flag}</p>}
        {where.length > 0 && <p className="mt-3 text-xs text-slate-400">{where.join(' › ')}</p>}
      </div>

      <LeadActionPanel
        leadId={lead.id}
        canPick={hasPermission(permissions, 'leads.pick')}
        canMark={hasPermission(permissions, 'leads.mark')}
        claim={claim}
        isOwner={isOwner}
        checklist={checklist}
        reasons={reasons}
        afterHref={afterHref}
      />

      {paymentLink && <PaymentLinkPanel {...paymentLink} />}

      {lead.qualification && lead.qualification.length > 0 && (
        <div className="rounded-xl border bg-white p-5 text-sm">
          <h3 className="text-sm font-semibold text-slate-600">Checklist from the call</h3>
          <ul className="mt-2 space-y-1">{lead.qualification.map(q => <li key={q.item}>{q.ticked ? '✔' : '✘'} {q.item}</li>)}</ul>
        </div>
      )}

      <div className="rounded-xl border bg-white p-5 text-sm">
        <h3 className="text-sm font-semibold text-slate-600">What they answered on the form</h3>
        {lead.answers.length === 0 ? <p className="mt-2 text-slate-500">No answers were received.</p> : (
          <dl className="mt-2 divide-y">
            {lead.answers.map((a, i) => (
              <div key={`${a.name}-${i}`} className="grid gap-1 py-2 sm:grid-cols-3">
                <dt className="text-slate-500">{prettyQuestion(a.name.replace(/\?$/, ''))}</dt>
                <dd className="sm:col-span-2">{a.values.length ? a.values.map(prettyAnswer).join(', ') : <span className="text-slate-400">—</span>}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      <div className="rounded-xl border bg-white p-5 text-sm">
        <h3 className="text-sm font-semibold text-slate-600">History</h3>
        <ol className="mt-2 space-y-1.5">
          {events.map(e => (
            <li key={e.id} className="flex justify-between gap-3 rounded-lg border px-3 py-2">
              <span>{eventText(e.kind, e.data, stages, reasons)}{e.actor !== 'system' && <span className="text-slate-400"> · {e.actor}</span>}</span>
              <span className="shrink-0 text-xs text-slate-400">{formatWhen(e.created_at)}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}
