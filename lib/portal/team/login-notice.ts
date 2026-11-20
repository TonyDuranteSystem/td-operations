/**
 * Team Powers step 6 — the notice a TEAM LOGIN itself accepts.
 *
 * A login added after step 4 has its notice accepted by the OWNER at the moment of adding (lib/portal/team/notice.ts, written to the
 * owner). The three logins that already existed when the record was introduced have no notice on file at all. The first time
 * one of them signs in, it sees THIS text, in its own words ("you"), and accepts it once. The exact words, the time and the
 * address are then saved with the login and in the team record.
 *
 * DRAFT WORDING (v1-draft-login): the final text is written by a lawyer, in English and Italian, before it is relied on.
 * Changing the text means a NEW version string. Pure and client-safe. "They" is used on purpose: the notice never guesses anyone's pronoun.
 */
import { describeCapabilities, type NoticeLang } from './capability-labels'
import type { CapabilityFlags } from './capabilities'
import { cleanName } from './notice'

export const TEAM_LOGIN_NOTICE_VERSION = 'v1-draft-login'

export interface TeamLoginNoticeInput {
  lang: NoticeLang
  memberName: string
  companyName: string
  caps: CapabilityFlags | Record<string, boolean>
}

export interface TeamLoginNotice {
  version: string
  title: string
  powersIntro: string
  powers: string[]
  responsibility: string
  never: string
  /** The exact words saved with the record. */
  text: string
}

export function buildTeamLoginNotice(i: TeamLoginNoticeInput): TeamLoginNotice {
  const company = cleanName(i.companyName)
  const it = i.lang === 'it'
  const powers = describeCapabilities(i.caps, i.lang)

  const title = it
    ? `Hai accesso a ${company} con un login del team.`
    : `You have access to ${company} through a team login.`
  const powersIntro = it ? 'Con questo login puoi:' : 'With this login you can:'
  const responsibility = it
    ? 'Tutto ciò che fai qui lo fai a nome dei titolari della società, e sono loro i responsabili di ciò che fai. Tony Durante LLC non controlla le tue azioni.'
    : 'Everything you do here you do in the name of the company’s owners, and they are responsible for what you do. Tony Durante LLC does not check your actions.'
  const never = it
    ? 'Con questo login non puoi mai firmare nulla, generare documenti, cambiare titolari o soci, gestire il team o cambiare l’accesso dei titolari. I titolari, o Tony Durante LLC, possono sospendere il tuo accesso in qualsiasi momento.'
    : 'With this login you can never sign anything, generate documents, change owners or members, manage the team or change the owners’ login. The owners, or Tony Durante LLC, can switch your access off at any time.'

  const none = it ? '(nessun potere selezionato)' : '(no powers ticked)'
  const lines = powers.length ? powers.map((p) => `- ${p}`) : [`- ${none}`]
  const text = [title, '', powersIntro, ...lines, '', responsibility, never, '', `[${TEAM_LOGIN_NOTICE_VERSION}]`].join('\n')

  return { version: TEAM_LOGIN_NOTICE_VERSION, title, powersIntro, powers, responsibility, never, text }
}

/** The sentence beside the accept button. */
export function teamLoginNoticeAcceptLabel(lang: NoticeLang): string {
  return lang === 'it' ? 'Ho letto e accetto' : 'I have read this and I accept'
}

/** Short headline above the notice while the login is waiting. */
export function teamLoginNoticeBannerTitle(lang: NoticeLang): string {
  return lang === 'it'
    ? 'Prima di continuare, leggi e accetta questa nota'
    : 'Before you continue, please read and accept this notice'
}

/** One line saying what is limited until the notice is accepted. */
export function teamLoginNoticeLimitLine(lang: NoticeLang): string {
  return lang === 'it'
    ? 'Finché non accetti, puoi vedere solo la pagina iniziale: il resto del tuo accesso torna subito dopo che accetti.'
    : 'Until you accept, you can only see the home page. The rest of your access comes back as soon as you accept.'
}
