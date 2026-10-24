import { LeadActionPanel } from '@/components/marketing/lead-action-panel'
import { PaymentLinkPanel, type PaymentLinkProps } from '@/components/marketing/payment-link-panel'
import { clientFlagText, eventText, formatWhen, prettyAnswer, prettyQuestion, stageLabel, telHref, type StageOption } from '@/lib/marketing/lead-view'
import type { LeadEventRow, LeadRow } from '@/lib/marketing/leads-read'
import { hasPermission, type MarketingPermission } from '@/lib/marketing/permissions'
import { answersWithoutPhone, canSeeNotes, canSeePhone, redactLead, redactTimeline } from '@/lib/marketing/lead-privacy'
import { buildSetterNote, personName } from '@/lib/marketing/setter-note'
import { SetterNoteBlock } from '@/components/marketing/setter-note-block'
import { ContactPanel } from '@/components/marketing/contact-panel'
import { contactState } from '@/lib/marketing/contact-state'
import { messageSigner, templatesFor, type TeamTemplates } from '@/lib/marketing/templates'
import { boardRole, type BoardRole } from '@/lib/marketing/board'
import { HandoverPanel } from '@/components/marketing/handover-panel'
import { getLang } from '@/lib/marketing/lang'
import { localeFor, makeT } from '@/lib/marketing/i18n'
import { getMarketingSetting } from '@/lib/marketing/settings'

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
  /** the person using the screen, as a name: the message is signed with the lead's SETTER, and this is only the fallback when nobody has worked the lead yet */
  myName?: string
  /** Antonio looking in as somebody else: his name is never put on a message */
  viewingAs?: boolean
  /** the board the person is working from (an owner can use both); default = his own role */
  role?: BoardRole
}

/** One lead, everything about it, with the buttons: used by the Leads screen and the Call list. A computer-width panel. Team-scoped by whoever loads it. */
export async function LeadPane({ lead: leadIn, events: eventsIn, stages, reasons, checklist, permissions, isOwner, myId, afterHref, paymentLink, myName, viewingAs, role: roleIn }: Props) {
  // What the team wrote (notes, the ticks from a call) is read only by people who work the leads; the ad person gets the facts without it.
  const lang = getLang()
  const t = makeT(lang)
  const loc = localeFor(lang)
  const fw = (iso: string | null | undefined) => formatWhen(iso, 'Europe/Rome', loc)
  const seesNotes = canSeeNotes(permissions)
  const lead0 = redactLead(leadIn, seesNotes)
  // no phone number (and no phone-looking form answer) in the page for someone who may not see phone numbers
  const lead = canSeePhone(permissions) ? lead0 : { ...lead0, phone: null, answers: answersWithoutPhone(lead0.answers, permissions) }
  const events = redactTimeline(eventsIn, seesNotes)
  const setterNote = seesNotes ? buildSetterNote(events, reasons) : null
  const claim = lead.claimed_by === null ? 'free' : lead.claimed_by === myId ? 'me' : 'other'
  const flag = clientFlagText(lead.existing_client, t)
  const tel = telHref(lead.phone)
  // what has been tried to reach the lead, and the messages the team sends (the team's own wording wins over the built-in ones)
  const contact = contactState(events)
  const overrides = lead.team_id ? ((await getMarketingSetting('message_templates', lead.team_id)) as Record<string, string>) : {}
  const custom = lead.team_id ? ((await getMarketingSetting('team_templates', lead.team_id)) as TeamTemplates) : {}
  const templates = templatesFor(lang, overrides, custom)
  const canAct = hasPermission(permissions, 'leads.mark') && !(claim === 'other' && !isOwner)
  // the seller (Rocco) and the setter see different lead pages: the setter's reaching-out box is the setter's work, not his
  const role = roleIn ?? boardRole(permissions)
  const signer = messageSigner({ claimedLabel: lead.claimed_by_label, events, viewerName: myName ?? '', viewingAs: viewingAs === true, nameOf: personName })
  const where = [lead.campaign_name, lead.adset_name, lead.ad_name].filter(Boolean)
  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-white p-5">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-xl font-semibold">{lead.full_name || lead.email || lead.phone || t('Unnamed lead')}</h2>
          <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs">{t(stageLabel(stages, lead.status))}</span>
        </div>
        <div className="mt-3 grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
          {lead.phone && <p><span className="text-slate-500">{t('Phone: ')}</span>{tel ? <a className="font-medium underline" href={tel}>{lead.phone}</a> : lead.phone}</p>}
          {lead.email && <p><span className="text-slate-500">{t('Email: ')}</span><a className="underline" href={`mailto:${lead.email}`}>{lead.email}</a></p>}
          {(lead.city || lead.country) && <p><span className="text-slate-500">{t('Place: ')}</span>{[lead.city, lead.country].filter(Boolean).join(', ')}</p>}
          <p><span className="text-slate-500">{t('Filled in: ')}</span>{fw(lead.meta_created_time ?? lead.received_at)}</p>
          <p><span className="text-slate-500">{t('Picked by: ')}</span>{lead.claimed_by === null ? t('nobody') : claim === 'me' ? t('you') : lead.claimed_by_label ?? t('a team member')}</p>
          {lead.callback_at && <p><span className="text-slate-500">{t('Call back: ')}</span><b>{fw(lead.callback_at)}</b></p>}
          {lead.not_in_target_reason && <p><span className="text-slate-500">{t('Not in target: ')}</span>{t(reasons.find(r => r.key === lead.not_in_target_reason)?.label ?? lead.not_in_target_reason)}</p>}
        </div>
        {flag && <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{flag}</p>}
        {where.length > 0 && <p className="mt-3 text-xs text-slate-400">{where.join(' › ')}</p>}
      </div>

      {setterNote && <SetterNoteBlock note={setterNote} ticks={lead.qualification} />}

      {role === 'setter' && <ContactPanel leadId={lead.id} canAct={canAct} contact={contact} leadName={lead.full_name} phone={canSeePhone(permissions) ? lead.phone : null} setterName={signer} templates={templates} canEditTemplates={isOwner} />}

      <HandoverPanel leadId={lead.id} role={role} canAct={canAct} contact={contact} />

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

      <div className="rounded-xl border bg-white p-5 text-sm">
        <h3 className="text-sm font-semibold text-slate-600">{t('What they answered on the form')}</h3>
        {lead.answers.length === 0 ? <p className="mt-2 text-slate-500">{t('No answers were received.')}</p> : (
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
        <h3 className="text-sm font-semibold text-slate-600">{t('History')}</h3>
        <ol className="mt-2 space-y-1.5">
          {events.map(e => (
            <li key={e.id} className="flex justify-between gap-3 rounded-lg border px-3 py-2">
              <span className="min-w-0 whitespace-pre-wrap break-words">{eventText(e.kind, e.data, stages, reasons, t, loc)}{e.actor !== 'system' && <span className="text-slate-400"> · {personName(e.actor)}{e.data?.via_view_as === true ? ` ${t('(viewing as)')}` : ''}</span>}</span>
              <span className="shrink-0 text-xs text-slate-400">{fw(e.created_at)}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}
