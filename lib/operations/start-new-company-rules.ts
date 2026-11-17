/**
 * "Start a new company" — the pure rules (no database, safe for the browser too).
 *
 * The case: the state accepted a new company's filing, the company already exists (Articles, EIN request), and then the
 * state refused the NAME (Novag LLC, Wyoming, 13 Nov 2026 — "not distinguishable from LLC Novag LLC"). Antonio does not
 * amend the name; the client opens a NEW company on the SAME paid offer. One button on the Contact page does it
 * (lib/operations/start-new-company.ts); this file holds the decisions that need no I/O so they can be tested alone.
 */

import { isItalian } from '@/lib/locale'
import { FORMATION_NAME_KEYS } from '@/lib/flows/formation-names'

const NAME_KEYS: ReadonlySet<string> = new Set(FORMATION_NAME_KEYS)
/** Every wizard key that holds a company name — the three choices and the older single-name shapes (chosen/final/company/business name). */
const isNameKey = (key: string): boolean => /^llc_name/i.test(key) || NAME_KEYS.has(key)

/**
 * The client-facing words of the first thing the client sees. Italian when the client's language on file is Italian — read
 * through the one shared helper (lib/locale.ts), so "Italian - englis" and "it-IT" count the same here as everywhere else.
 */
export function buildReplacementMessage(p: {
  language: string | null | undefined
  firstName: string | null | undefined
  oldCompanyName: string
}): string {
  const first = (p.firstName ?? '').trim()
  const old = p.oldCompanyName.trim()
  if (isItalian(p.language)) {
    return [
      first ? `Ciao ${first},` : 'Ciao,',
      `lo Stato non ha accettato il nome ${old} perché troppo simile a una società già registrata. Apriamo quindi una nuova società: nel portale trovi il modulo da compilare, dove potrai indicare i tre nomi tra cui scegliere.`,
      'Il pagamento già effettuato resta valido per la nuova società: non devi pagare di nuovo adesso. La seconda parte, se prevista, seguirà come concordato.',
      'Grazie e buona giornata.',
    ].join('\n')
  }
  return [
    first ? `Hi ${first},` : 'Hi,',
    `the state did not accept the name ${old} because it is too close to a company already registered. We are opening a new company for you: in the portal you will find the form to fill in, where you can give us three names to choose from.`,
    'The payment you already made stays valid for the new company, so you do not pay again now. The second part, if there is one, will follow as agreed.',
    'Thank you.',
  ].join('\n')
}

/**
 * The wizard answers that carry over to the reopened wizard: the people, passports, address and business purpose stay (the
 * client only checks them); the company NAMES go (they are what the state refused) and the disclaimer has to be accepted
 * again. A copy — the input is never changed.
 */
export function seedReopenedWizardData(data: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data ?? {})) {
    if (isNameKey(key)) continue
    if (key === 'disclaimer_accepted') continue
    out[key] = value
  }
  return out
}

/**
 * The names the client had given, for the note left on the cancelled job (so the history keeps them after the wizard is reset).
 * Reads every name key, not only the three choices, so an older single-name wizard is remembered too. Order and duplicates: first seen wins.
 */
export function wizardNamesOf(data: Record<string, unknown> | null | undefined): string[] {
  const names: string[] = []
  for (const [key, value] of Object.entries(data ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (!isNameKey(key)) continue
    const text = typeof value === 'string' ? value.trim() : ''
    if (text && !names.includes(text)) names.push(text)
  }
  return names
}

/** The facts the decision needs about the company being replaced (all read from the database by the caller). */
export interface ReplaceFacts {
  jobStatus: string | null
  hasCompany: boolean
  sourceOfferToken: string | null
  offerFound: boolean
  unpaidInvoices: number
  leaseInForce: number
}

/**
 * Why this company cannot be replaced from the button — plain English, one sentence each. An empty list means it can.
 * Money and leases are never touched by the button, so a company that has them is handed back to a human.
 */
export function replaceBlockers(f: ReplaceFacts): string[] {
  const out: string[] = []
  if (f.jobStatus !== 'active') out.push('This formation job is no longer active, so there is nothing to replace.')
  if (!f.hasCompany) out.push('This formation has no company yet. Use the name check on the formation job instead.')
  if (!f.sourceOfferToken) out.push('This formation job is not tied to an offer, so the payment cannot follow the new company.')
  else if (!f.offerFound) out.push('The offer this formation came from could not be found, so the payment cannot follow the new company.')
  if (f.unpaidInvoices > 0) {
    out.push(`The company or its offer has ${f.unpaidInvoices} unpaid invoice${f.unpaidInvoices === 1 ? '' : 's'}. Settle or cancel ${f.unpaidInvoices === 1 ? 'it' : 'them'} first.`)
  }
  if (f.leaseInForce > 0) out.push('The company has an office lease in force. End the lease first.')
  return out
}

interface PlanPartLike {
  seq?: number
  amount?: number
  currency?: string
  trigger?: { kind?: string; service_type?: string; stage?: string; label?: string }
}

/**
 * The sentence for the pop-up about the part of the payment that waits for the new company. Only a part that waits for a
 * Company Formation step is mentioned (it is the one that follows the job); null when the offer has no such part, or when that
 * part has already been invoiced (`alreadyInvoiced` = the part numbers that have an invoice).
 */
export function describeWaitingPart(plan: unknown, alreadyInvoiced: readonly number[] = []): string | null {
  if (!Array.isArray(plan)) return null
  for (const raw of plan as PlanPartLike[]) {
    const t = raw?.trigger
    if (t?.kind !== 'step' || (t.service_type ?? '').trim().toLowerCase() !== 'company formation') continue
    // A part that already has an invoice is not waiting for anything any more — saying it "waits" would be untrue.
    if (typeof raw.seq === 'number' && alreadyInvoiced.includes(raw.seq)) continue
    const amount = typeof raw.amount === 'number' ? `${raw.amount.toLocaleString('en-US')} ${raw.currency ?? ''}`.trim() : null
    const part = typeof raw.seq === 'number' ? `Part ${raw.seq}` : 'The next part'
    const label = t.label?.trim()
    const when = label ? `waits for the new company ("${label}")` : `waits until the new company reaches "${t.stage ?? 'its next step'}"`
    return `${part}${amount ? ` (${amount})` : ''} of the payment ${when}.`
  }
  return null
}

/** The line left on the NEW job, so a second press resumes instead of starting twice, and a person can see where it came from. */
export function replacementNote(oldDeliveryId: string, oldCompanyName: string, on: string, by: string): string {
  return `Replaces job ${oldDeliveryId} (${oldCompanyName}) — the state refused the company name. Opened ${on} by ${by}.`
}

/** True when this job's notes say it replaced that job. */
export function isReplacementOf(notes: string | null | undefined, oldDeliveryId: string): boolean {
  return (notes ?? '').includes(`Replaces job ${oldDeliveryId} `)
}

/**
 * The words every cancellation made by the button carries (the reason handed to the job cancellation, which writes it into the job's
 * notes). One place, so the button and the add-on check agree: a job cancelled for this reason belonged to the company that was
 * replaced, so the NEW company still gets its own copy (see lib/operations/activation-start-services.ts).
 */
export const COMPANY_REPLACED_REASON = 'The company was replaced by a new one'

/** True when a job was cancelled because the button replaced its company (as opposed to a person cancelling it on purpose). */
export function wasCancelledByCompanyReplacement(status: string | null | undefined, notes: string | null | undefined): boolean {
  return status === 'cancelled' && (notes ?? '').includes(COMPANY_REPLACED_REASON)
}

/** The marker written once the client's message has gone out, so a resumed press does not send it twice. */
export const MESSAGE_SENT_MARKER = 'Client message sent'

/**
 * The marker written once the client's wizard has been reopened. A resumed press that finds it NEVER touches the wizard again:
 * by then the client may already have typed (or even re-submitted) the new names, and reopening would wipe them.
 */
export const WIZARD_REOPENED_MARKER = 'Wizard reopened'

/** The line that carries the marker, plus the names the client had given (the wizard forgets them when it is reopened). */
export function wizardReopenedNote(on: string, names: string[]): string {
  return `${on} — ${WIZARD_REOPENED_MARKER} for the new names.${names.length ? ` Names the client had given: ${names.join(' / ')}.` : ''}`
}

/**
 * The words for staff when the new job could not be opened. The database allows ONE waiting formation per offer, so a second press
 * that arrives at the same moment as the first is stopped by a "duplicate key" error — say that in plain words instead of showing
 * the raw database message (found pressing twice at once in browser QA, 2026-11-17; nothing had changed and only one press went through).
 */
export function newJobFailureText(message: string | null | undefined): string {
  const m = (message ?? '').trim()
  if (/duplicate key|uq_formation_sd_active_per_offer/i.test(m)) {
    return 'Someone else pressed this button for the same company at the same moment, so a new formation is already being opened. Nothing was changed by this press — wait a few seconds and refresh the page.'
  }
  return `The new formation could not be opened: ${m || 'unknown error'}`
}

/** Written when the press found NO saved wizard: it carries the same marker, so a repeated press never touches a wizard the client has started since. */
export function wizardNothingToReopenNote(on: string): string {
  return `${on} — ${WIZARD_REOPENED_MARKER}: nothing was saved to reopen, so any wizard the client starts from now on is left untouched.`
}

/** The names recorded by `wizardReopenedNote`, so a resumed press can still write them into the old job's history. */
export function namesFromReopenedNote(notes: string | null | undefined): string[] {
  const m = (notes ?? '').match(/Names the client had given: (.*)$/m)
  if (!m) return []
  return m[1].replace(/\.$/, '').split(' / ').map((n) => n.trim()).filter(Boolean)
}
