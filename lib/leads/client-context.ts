// Is this lead already a client? (dev job 6fc63c52, Antonio 2026-11-02: "the system must look for information inside the
// CRM to make the right decision".) Pure: the caller gathers the CRM facts, this weighs them.
//
// Signals, each one sourced so the question card can say WHERE it was found:
//   email         the lead's email is on a client contact (email, email_2 or alt_emails)      -> strong
//   phone         the lead's phone (or a WhatsApp chat number) is on a client contact           -> medium
//   name          the lead's full name equals a client contact's name                            -> medium
//   attendee      a name on the call recording equals a client contact's name                    -> weak
//   company       the call notes mention one of that contact's companies                         -> medium
// Verdict: "sure" (email, or phone together with a name) acts by itself; "maybe" (anything else) is asked of Antonio;
// "none" means nothing in the CRM points at a client. A staff answer overrides: "client" is sure, "new_lead" is none
// for that contact. A "client" contact here is one that belongs to at least one company.

export interface ClientContact {
  id: string
  full_name: string | null
  email: string | null
  email_2?: string | null
  alt_emails?: string[] | null
  phone: string | null
  phone_2?: string | null
  phone_3?: string | null
  phone_4?: string | null
  companies: { name: string; status: string | null }[]
}

export interface LeadIdentity { full_name: string | null; email: string | null; phone: string | null }

export interface ClientEvidence {
  /** people named on the lead's call recordings */
  attendees?: { name?: string | null; email?: string | null }[]
  /** the call notes of the lead's recordings, joined */
  notesText?: string
  /** numbers of WhatsApp chats linked to the lead */
  chatPhones?: string[]
}

export type AnswerStatus = 'client' | 'new_lead' | 'later'
export interface ClientAnswer { contactId: string; status: AnswerStatus }

export interface ClientReason { text: string; source: string }

export type Verdict = 'sure' | 'maybe' | 'none'
export interface ClientVerdict {
  verdict: Verdict
  contactId: string | null
  contactName: string | null
  companies: { name: string; status: string | null }[]
  reasons: ClientReason[]
  /** true when Antonio already said so (the reasons then say who confirmed it is not kept here) */
  answered: AnswerStatus | null
}

export const NO_VERDICT: ClientVerdict = { verdict: 'none', contactId: null, contactName: null, companies: [], reasons: [], answered: null }

export function normEmail(v: string | null | undefined): string {
  return (v ?? '').trim().toLowerCase()
}

export function digitsOnly(v: string | null | undefined): string {
  return (v ?? '').replace(/\D/g, '')
}

/** Two phone numbers are the same line when their digits are equal, or one is the other with a country prefix (8+ shared trailing digits). */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = digitsOnly(a)
  const y = digitsOnly(b)
  if (x.length < 7 || y.length < 7) return false
  if (x === y) return true
  const shorter = x.length <= y.length ? x : y
  const longer = x.length <= y.length ? y : x
  return shorter.length >= 8 && longer.endsWith(shorter)
}

/** Lower case, accents and punctuation removed, one-letter words dropped, words sorted ("Rossi, Marco" = "marco rossi"). Needs two words to count. */
export function normName(v: string | null | undefined): string {
  const tokens = (v ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1)
  return tokens.length >= 2 ? tokens.sort().join(' ') : ''
}

const LEGAL_WORDS = new Set(['llc', 'inc', 'corp', 'ltd', 'limited', 'srl', 'spa', 'co', 'company', 'corporation', 'the'])

/** "Verdi Consulting LLC" -> "verdi consulting"; '' when too short to be told apart from ordinary words. */
export function companyCore(name: string | null | undefined): string {
  const words = (name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w && !LEGAL_WORDS.has(w))
  const core = words.join(' ')
  return core.length >= 7 ? core : ''
}

function notesMention(notesText: string, core: string): boolean {
  if (!core) return false
  const hay = ` ${notesText.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ')} `
  return hay.indexOf(` ${core} `) !== -1
}

function contactEmails(c: ClientContact): string[] {
  return [c.email, c.email_2, ...(c.alt_emails ?? [])].map(normEmail).filter(Boolean)
}

function contactPhones(c: ClientContact): string[] {
  return [c.phone, c.phone_2, c.phone_3, c.phone_4].filter((p): p is string => !!p)
}

interface Scored { contact: ClientContact; score: number; strong: boolean; reasons: ClientReason[]; hasName: boolean; hasPhone: boolean }

function scoreContact(c: ClientContact, lead: LeadIdentity, ev: ClientEvidence): Scored {
  const reasons: ClientReason[] = []
  let score = 0
  const who = c.full_name ?? 'this contact'

  const leadEmail = normEmail(lead.email)
  const email = !!leadEmail && contactEmails(c).indexOf(leadEmail) !== -1
  if (email) { score += 10; reasons.push({ text: `The email ${leadEmail} is saved on the contact ${who}.`, source: 'Lead email, compared with CRM contacts' }) }

  const numbers = [lead.phone, ...(ev.chatPhones ?? [])].filter((p): p is string => !!p)
  const phoneHit = numbers.find(n => contactPhones(c).some(cp => samePhone(n, cp)))
  const phone = !!phoneHit
  if (phone) { score += 3; reasons.push({ text: `The phone number ${phoneHit} is saved on the contact ${who}.`, source: 'Lead phone or WhatsApp chat, compared with CRM contact phones' }) }

  const cn = normName(c.full_name)
  const name = !!cn && normName(lead.full_name) === cn
  if (name) { score += 3; reasons.push({ text: `The lead's name matches the contact ${who}.`, source: 'Lead name, compared with CRM contacts' }) }

  const attendee = !name && !!cn ? (ev.attendees ?? []).find(a => normName(a.name) === cn) : undefined
  if (attendee) { score += 2; reasons.push({ text: `The name on the call recording, "${attendee.name}", matches the contact ${who}.`, source: 'Call recording attendees, compared with CRM contacts' }) }

  if (ev.notesText) {
    const hit = c.companies.find(co => notesMention(ev.notesText as string, companyCore(co.name)))
    if (hit) { score += 3; reasons.push({ text: `The call notes mention ${hit.name}, a company of that contact${hit.status ? ` (${hit.status})` : ''}.`, source: 'Call notes, compared with CRM companies' }) }
  }

  return { contact: c, score, strong: email, reasons, hasName: name || !!attendee, hasPhone: phone }
}

/** Weigh the CRM facts about one lead. `contacts` are client contacts only (each belongs to at least one company). */
export function resolveClientVerdict(input: { lead: LeadIdentity; contacts: ClientContact[]; evidence?: ClientEvidence; answers?: ClientAnswer[]; markedContactId?: string | null }): ClientVerdict {
  const ev = input.evidence ?? {}
  const answers = input.answers ?? []
  const byId = new Map<string, ClientContact>()
  for (const c of input.contacts) byId.set(c.id, c)

  // 1. The lead is already marked as a client contact, or Antonio said "client": settled.
  const settledId = input.markedContactId ?? (answers.find(a => a.status === 'client')?.contactId ?? null)
  if (settledId) {
    const c = byId.get(settledId)
    const viaAnswer = !input.markedContactId
    return {
      verdict: 'sure',
      contactId: settledId,
      contactName: c?.full_name ?? null,
      companies: c?.companies ?? [],
      reasons: [{ text: viaAnswer ? 'You confirmed this person is an existing client.' : 'This lead is marked as an existing client.', source: viaAnswer ? 'Your answer on the lead' : 'Lead record' }],
      answered: viaAnswer ? 'client' : null,
    }
  }

  // 2. Weigh every client contact; a contact Antonio already ruled out ("new_lead") is skipped.
  const ruledOut = new Set(answers.filter(a => a.status === 'new_lead').map(a => a.contactId))
  const scored = input.contacts
    .filter(c => c.companies.length > 0 && !ruledOut.has(c.id))
    .map(c => scoreContact(c, input.lead, ev))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || a.contact.id.localeCompare(b.contact.id))

  if (scored.length === 0) return { ...NO_VERDICT, answered: ruledOut.size > 0 ? 'new_lead' : null }

  const best = scored[0]
  const sure = best.strong || (best.hasPhone && best.hasName)
  return {
    verdict: sure ? 'sure' : 'maybe',
    contactId: best.contact.id,
    contactName: best.contact.full_name,
    companies: best.contact.companies,
    reasons: best.reasons,
    answered: answers.some(a => a.contactId === best.contact.id && a.status === 'later') ? 'later' : null,
  }
}
