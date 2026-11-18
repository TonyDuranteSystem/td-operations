/**
 * Team Powers — the responsibility notice an owner accepts before giving someone access (or more access).
 *
 * The owner sees exactly this text, ticks "I understand", re-enters their password, and the server saves the SAME text,
 * its version, the time and the address with the record. The text is built from the powers actually ticked, in the
 * owner's language, from labels shared with the Team screen and the emails.
 *
 * DRAFT WORDING (v1-draft): the final text is written by a lawyer, in English and Italian, before it goes live.
 * Changing the text means a NEW version string: the server refuses an older version, so nobody accepts words they did not see.
 *
 * Pure and client-safe. "They" is used on purpose: the notice never guesses anyone's pronoun.
 */
import { describeCapabilities, type NoticeLang } from './capability-labels'
import type { CapabilityFlags } from './capabilities'

export const NOTICE_VERSION = 'v1-draft'

export type NoticeMode = 'add' | 'more'

export interface NoticeInput {
  lang: NoticeLang
  mode: NoticeMode
  memberName: string
  companyName: string
  caps: CapabilityFlags | Record<string, boolean>
}

export interface Notice {
  version: string
  title: string
  powersIntro: string
  powers: string[]
  responsibility: string
  never: string
  /** The exact words saved with the record. */
  text: string
}

/** One spelling of a name everywhere: trimmed, repeated spaces collapsed. */
export function cleanName(name: string | null | undefined): string {
  return (name ?? '').trim().replace(/\s+/g, ' ')
}

export function buildNotice(i: NoticeInput): Notice {
  const member = cleanName(i.memberName) || (i.lang === 'it' ? 'questa persona' : 'this person')
  const company = cleanName(i.companyName)
  const powers = describeCapabilities(i.caps, i.lang)
  const it = i.lang === 'it'

  const title = it
    ? (i.mode === 'add' ? `Stai per dare a ${member} accesso a ${company}.` : `Stai per dare a ${member} più poteri in ${company}.`)
    : (i.mode === 'add' ? `You are about to give ${member} access to ${company}.` : `You are about to give ${member} more powers in ${company}.`)
  const powersIntro = it ? 'Questa persona potrà:' : 'This person will be able to:'
  const responsibility = it
    ? 'Tutto ciò che selezioni, questa persona può farlo a nome tuo, e sei tu il responsabile di ciò che fa. Tony Durante LLC non controlla le sue azioni.'
    : 'Everything you tick, this person can do in your name, and you are responsible for what they do. Tony Durante LLC does not check their actions.'
  const never = it
    ? 'Non potrà mai firmare nulla, generare documenti, cambiare titolari o soci, gestire il team o cambiare il tuo accesso. Puoi sospenderla in qualsiasi momento.'
    : 'They can never sign anything, generate documents, change owners or members, manage the team or change your login. You can switch them off at any time.'

  const none = it ? '(nessun potere selezionato)' : '(no powers ticked)'
  const lines = powers.length ? powers.map((p) => `- ${p}`) : [`- ${none}`]
  const text = [title, '', powersIntro, ...lines, '', responsibility, never, '', `[${NOTICE_VERSION}]`].join('\n')

  return { version: NOTICE_VERSION, title, powersIntro, powers, responsibility, never, text }
}

/** The sentence beside the tick box. */
export function noticeCheckboxLabel(lang: NoticeLang): string {
  return lang === 'it'
    ? 'Ho capito che sto dando questi poteri e che ne sono responsabile.'
    : 'I understand that I am giving these powers and that I am responsible for them.'
}
