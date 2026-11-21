/**
 * Team Powers — the email every owner and member gets when someone is added to the team or given more powers.
 *
 * This email is the safety net (the owner who acted may not be the only owner), so it is simple and it carries no secret:
 * no password, no one-click "undo" link — only the fixed address of the Team screen. Names are escaped (a colleague's name is
 * typed by an owner). Tony Durante LLC is never a recipient. English or Italian per recipient.
 *
 * Pure: the job handler builds the facts and sends; this file only writes the words.
 */
import { isItalian } from '@/lib/locale'

export type TeamNoticeKind = 'added' | 'more'

export interface TeamNoticeEmailInput {
  /** The recipient's language, free text from the contact record ("Italian", "it", ...). */
  language: string | null | undefined
  recipientFirstName: string | null
  actorName: string
  memberName: string
  companyName: string
  kind: TeamNoticeKind
  /** Labels (already in the recipient's language) of what the person can do now. */
  powers: string[]
  /** For kind 'more': labels of the powers just added. */
  newPowers: string[]
  when: Date
  /** The fixed address of the Team screen. */
  teamUrl: string
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** RFC 2047 so accents and non-Latin names survive (R041). */
export function encodeSubject(subject: string): string {
  return `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`
}

export function formatWhen(when: Date, it: boolean): string {
  return new Intl.DateTimeFormat(it ? 'it-IT' : 'en-US', { timeZone: 'America/New_York', dateStyle: 'long', timeStyle: 'short' }).format(when)
}

export function buildTeamNoticeEmail(i: TeamNoticeEmailInput): { subject: string; html: string; text: string } {
  const it = isItalian(i.language)
  const e = escapeHtml
  const when = formatWhen(i.when, it)
  const greeting = i.recipientFirstName ? (it ? `Ciao ${i.recipientFirstName},` : `Hi ${i.recipientFirstName},`) : (it ? 'Ciao,' : 'Hi,')

  const subject = it
    ? (i.kind === 'added' ? `Nuovo accesso al team di ${i.companyName}: ${i.memberName}` : `Accesso del team modificato in ${i.companyName}: ${i.memberName}`)
    : (i.kind === 'added' ? `New team access at ${i.companyName}: ${i.memberName}` : `Team access changed at ${i.companyName}: ${i.memberName}`)

  const lead = it
    ? (i.kind === 'added'
      ? `${i.actorName} ha aggiunto ${i.memberName} al team di ${i.companyName} il ${when} (ora di New York).`
      : `${i.actorName} ha dato a ${i.memberName} più poteri in ${i.companyName} il ${when} (ora di New York).`)
    : (i.kind === 'added'
      ? `${i.actorName} added ${i.memberName} to the ${i.companyName} team on ${when} (New York time).`
      : `${i.actorName} gave ${i.memberName} more powers in ${i.companyName} on ${when} (New York time).`)

  const newLine = i.kind === 'more' && i.newPowers.length
    ? (it ? `Nuovi poteri: ${i.newPowers.join(', ')}.` : `New powers: ${i.newPowers.join(', ')}.`)
    : ''
  const canLabel = it ? `${i.memberName} può:` : `${i.memberName} can:`
  const nothing = it ? '(nessun potere)' : '(nothing)'
  const powers = i.powers.length ? i.powers : [nothing]
  const warn = it
    ? `Se ti sorprende, accedi al portale, apri Team e sospendi ${i.memberName}.`
    : `If this surprises you, sign in to the portal, open Team and switch ${i.memberName} off.`
  const cta = it ? 'Apri Team' : 'Open Team'
  const footer = it ? 'Tony Durante LLC — Portale Clienti' : 'Tony Durante LLC — Client Portal'

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#0A3161;padding:20px;border-radius:12px 12px 0 0;">
        <img src="https://app.tonydurante.us/images/logo.jpg" alt="Tony Durante LLC" style="height:40px;" />
      </div>
      <div style="border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 12px 12px;">
        <p style="margin:0 0 16px;">${e(greeting)}</p>
        <p style="margin:0 0 12px;">${e(lead)}</p>
        ${newLine ? `<p style="margin:0 0 12px;">${e(newLine)}</p>` : ''}
        <p style="margin:0 0 6px;">${e(canLabel)}</p>
        <ul style="margin:0 0 16px;padding-left:20px;">${powers.map((p) => `<li>${e(p)}</li>`).join('')}</ul>
        <p style="margin:0 0 24px;color:#52525b;font-size:14px;">${e(warn)}</p>
        <a href="${e(i.teamUrl)}" style="display:inline-block;padding:12px 28px;background:#0A3161;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;">${e(cta)}</a>
        <p style="color:#9ca3af;font-size:12px;margin-top:24px;">${e(footer)}</p>
      </div>
    </div>`

  const text = [greeting, '', lead, newLine, canLabel, ...powers.map((p) => `- ${p}`), '', warn, i.teamUrl].filter((l, idx, a) => !(l === '' && a[idx - 1] === '')).join('\n')
  return { subject, html, text }
}
