/**
 * Team Powers step 7 — the notice an OWNER accepts before sharing THEIR OWN personal documents with a team login.
 *
 * Same shape as the notice for giving powers (lib/portal/team/notice.ts), so the existing confirmation check — the owner accepts exactly
 * this text and re-enters their password in the same request — works unchanged. The text names what is shared in plain words
 * (passport, ID, proof of address, tax numbers) and says plainly that it is only the owner's OWN papers, never a co-owner's.
 *
 * DRAFT WORDING (v1-draft-personal-docs): a lawyer may later write the final text, in English and Italian. Changing the text means a NEW
 * version string: the server refuses an older version, so nobody accepts words they did not see.
 * Pure and client-safe. "They" is used on purpose: the notice never guesses anyone's pronoun.
 */
import type { NoticeLang } from './capability-labels'
import { cleanName, type Notice } from './notice'

export const PERSONAL_DOCS_NOTICE_VERSION = 'v1-draft-personal-docs'

export interface PersonalDocsNoticeInput {
  lang: NoticeLang
  memberName: string
  companyName: string
}

export function buildPersonalDocsNotice(i: PersonalDocsNoticeInput): Notice {
  const member = cleanName(i.memberName) || (i.lang === 'it' ? 'questa persona' : 'this person')
  const company = cleanName(i.companyName)
  const it = i.lang === 'it'

  const title = it
    ? `Stai per permettere a ${member} di vedere i TUOI documenti personali.`
    : `You are about to let ${member} see YOUR personal documents.`
  const powersIntro = it ? 'Questa persona potrà vedere e scaricare:' : 'This person will be able to see and download:'
  const powers = [
    it
      ? `I documenti personali conservati per te nel portale di ${company}, come passaporto, documento d’identità, prova di residenza e codici fiscali o ITIN.`
      : `The personal documents kept for you in the ${company} portal, such as your passport, ID, proof of address and tax numbers.`,
  ]
  const responsibility = it
    ? 'Sono i tuoi documenti privati. Una volta attivato, questa persona può aprirli e scaricarli tutti, e sei tu il responsabile di ciò. Tony Durante LLC non controlla cosa ne fa.'
    : 'These are your own private papers. Once you switch this on, this person can open and download all of them, and you are responsible for that. Tony Durante LLC does not check what they do with them.'
  const never = it
    ? 'Vengono condivisi solo i TUOI documenti, mai quelli di un altro titolare o socio. Puoi disattivarlo in qualsiasi momento e smette subito.'
    : 'Only YOUR documents are shared, never another owner’s or member’s. You can switch this off at any time and it stops at once.'

  const text = [title, '', powersIntro, ...powers.map((p) => `- ${p}`), '', responsibility, never, '', `[${PERSONAL_DOCS_NOTICE_VERSION}]`].join('\n')
  return { version: PERSONAL_DOCS_NOTICE_VERSION, title, powersIntro, powers, responsibility, never, text }
}

/** The sentence beside the tick box. */
export function personalDocsCheckboxLabel(lang: NoticeLang): string {
  return lang === 'it'
    ? 'Ho capito che sto condividendo i miei documenti personali e che ne sono responsabile.'
    : 'I understand that I am sharing my personal documents and that I am responsible for that.'
}
