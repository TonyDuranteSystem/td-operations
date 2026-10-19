/**
 * The names loop (propose names → staff checks them with the state → ONE available name goes to the
 * client to confirm → file → the state accepts or refuses → when every name is used up the client is
 * asked for a new one) is shared by two services. This file is the ONLY place where they differ, so
 * the loop's engine (lib/operations/formation-name-checks.ts, components/flows/formation-names.tsx)
 * has no service-specific `if`s of its own:
 *
 *   - Company Formation: exactly what it has always done (names seeded from the formation wizard,
 *     the name-selection stage is "Wizard Submitted", a state refusal moves the case back there, the
 *     state falls back to New Mexico, the client is asked for 3 new names).
 *   - Company Change Name (dev job bb64c417): no wizard (the names are asked in the portal), the
 *     panel works wherever the stage layout shows it, ONE name at a time, the state is the company's
 *     own (and the action is refused when it is not on record — never "New Mexico"), the client is
 *     asked for ONE new name, and a state refusal does NOT move the stage (staff presses Go back —
 *     Antonio's decision 2026-10-19).
 *
 * Pure (no I/O) and client-safe: the staff panel and the server both import it. A service type with no
 * policy has no names loop at all (the API refuses it).
 *
 * ALL client-facing wording of the loop lives in the copy builders below, in one place, so it can be
 * read and approved as a page. The Company Change Name wording is a DRAFT until Antonio approves it.
 */

import { CHANGE_NAME_STAGES } from '@/lib/flows/change-name-stages'

export type NameLoopKey = 'formation' | 'change_name'

export interface NameLoopPolicy {
  key: NameLoopKey
  serviceType: string
  /** Seed the first candidates from the contact's formation wizard / form submission. */
  seedFromFormationWizard: boolean
  /** Stages where staff may type a name by hand; null = wherever the stage layout shows the panel. */
  addNameStages: readonly string[] | null
  /** Only one name may be with the client / accepted / filed at a time. */
  oneAtATime: boolean
  /** How many names the client is asked for once every name is used up. */
  newNamesCount: number
  /** How many names the very first ask ("send us your names") requests; 0 = this service has no first-ask action. */
  firstNamesCount: number
  /** How a client's free-text answer is cut into names. */
  split: 'all' | 'lines'
  /**
   * 'formation_chain': the account's state, else wizard → form submission → signed offer, else New Mexico.
   * 'account_required': the account's own state only; the action is refused when it is not on record.
   */
  stateRule: 'formation_chain' | 'account_required'
  /** A state refusal moves the case back to this stage (Formation); null = leave the stage to staff. */
  revertStageOnSosRejected: string | null
  /**
   * The stage staff sends the case back to — with ONE press, documents kept — once every name is used up
   * (the "return_to_names" action); null = the service has no such action. A name change leaves the move to
   * staff (Antonio 2026-10-19) but must not make them press Go back four times, each deleting the documents
   * of the step it returns to.
   */
  returnStage: string | null
  /** The panel shows the formation "Check/File on SOS" links and the "Name Confirmed & Filed" advance button. */
  formationPanelExtras: boolean
  /** Word used for the thing being named in staff-facing text. */
  noun: string
}

const FORMATION: NameLoopPolicy = {
  key: 'formation',
  serviceType: 'Company Formation',
  seedFromFormationWizard: true,
  addNameStages: ['Wizard Submitted'],
  oneAtATime: false,
  newNamesCount: 3,
  firstNamesCount: 0,
  split: 'all',
  stateRule: 'formation_chain',
  revertStageOnSosRejected: 'Wizard Submitted',
  returnStage: null,
  formationPanelExtras: true,
  noun: 'LLC name',
}

const CHANGE_NAME: NameLoopPolicy = {
  key: 'change_name',
  serviceType: 'Company Change Name',
  seedFromFormationWizard: false,
  addNameStages: null,
  oneAtATime: true,
  newNamesCount: 1,
  firstNamesCount: 3,
  split: 'lines',
  stateRule: 'account_required',
  revertStageOnSosRejected: null,
  returnStage: CHANGE_NAME_STAGES.collect,
  formationPanelExtras: false,
  noun: 'company name',
}

const POLICIES: Readonly<Record<string, NameLoopPolicy>> = {
  [FORMATION.serviceType]: FORMATION,
  [CHANGE_NAME.serviceType]: CHANGE_NAME,
}

/** The loop's rules for a service type, or null when the service has no names loop. */
export function nameLoopPolicyFor(serviceType: string | null | undefined): NameLoopPolicy | null {
  if (typeof serviceType !== 'string') return null
  return POLICIES[serviceType] ?? null
}

/** The stages where staff may add a name by hand (the formation name-selection stage), or null for "wherever the layout shows the panel". */
export function canAddNameAtStage(policy: NameLoopPolicy, stage: string | null | undefined): boolean {
  if (policy.addNameStages === null) return true
  return typeof stage === 'string' && policy.addNameStages.includes(stage)
}

// ───────────────────────── Client-facing wording ─────────────────────────

export interface DecisionCopy {
  title: string
  message: string
  message_it: string
  options: Record<string, unknown>
}

/** "Acme" → "Acme LLC" (the card's hero title); a name that already says LLC is left alone. */
export function displayNameFor(name: string): string {
  return /llc\b/i.test(name) ? name : `${name} LLC`
}

/** The approval card for ONE available name. */
export function approvalCopy(
  policy: NameLoopPolicy,
  a: { name: string; state: string; nameIndex: number },
): DecisionCopy {
  const displayName = displayNameFor(a.name)
  const marker = { kind: 'approval', name_index: a.nameIndex, name: a.name }
  if (policy.key === 'change_name') {
    return {
      title: displayName,
      message:
        `We checked ${displayName} and it is currently available in ${a.state}.\n\n` +
        `We would like to prepare the name-change form with this name and file it with the Secretary of State.\n\n` +
        `Please note: the final approval is up to the Secretary of State. If they reject this name, we will ask you for a new one.\n\n` +
        `Do you approve using this name?`,
      message_it:
        `Abbiamo verificato ${displayName} ed è attualmente disponibile in ${a.state}.\n\n` +
        `Vorremmo preparare il modulo di cambio nome con questo nome e presentarlo al Secretary of State.\n\n` +
        `Nota bene: l'approvazione finale spetta al Secretary of State. Se rifiutasse questo nome, ti chiederemo un nuovo nome.\n\n` +
        `Approvi l'uso di questo nome?`,
      options: {
        approve_label: 'Yes, use this name',
        reject_label: 'No, I prefer another name',
        approve_label_it: 'Sì, usa questo nome',
        reject_label_it: 'No, preferisco un altro nome',
        title_it: displayName,
        name_check: marker,
      },
    }
  }
  return {
    title: displayName,
    message:
      `We checked ${displayName} and this name is currently available in ${a.state}.\n\n` +
      `We'd like to proceed with filing this name with the Secretary of State.\n\n` +
      `Please note: the final approval is up to the Secretary of State. If they reject this name, we'll try your other choices or you can propose new ones.\n\n` +
      `Do you approve filing with this name?`,
    message_it:
      `Abbiamo verificato ${displayName} e questo nome è attualmente disponibile in ${a.state}.\n\n` +
      `Vorremmo procedere con la registrazione di questo nome presso il Secretary of State.\n\n` +
      `Nota bene: l'approvazione finale spetta al Secretary of State. Se il nome venisse rifiutato, proveremo con le altre opzioni oppure potrai proporne di nuove.\n\n` +
      `Approvi la registrazione con questo nome?`,
    options: {
      approve_label: 'Yes, proceed',
      reject_label: 'No, use a different name',
      approve_label_it: 'Sì, procedi',
      reject_label_it: 'No, usa un altro nome',
      name_check: marker,
    },
  }
}

/** The "send us a new name" card, when every name is used up. */
export function newNamesCopy(
  policy: NameLoopPolicy,
  a: { reason: 'none_available' | 'sos_rejected'; rejectedName?: string },
): DecisionCopy {
  // Formation's marker stays exactly {kind:'new_names'} (comma split, cap 5 — unchanged).
  const marker: Record<string, unknown> = { kind: 'new_names' }
  if (policy.split === 'lines') marker.split = 'lines'
  if (policy.key === 'change_name') marker.max = policy.newNamesCount
  if (policy.key === 'change_name') {
    const sos = a.reason === 'sos_rejected' && a.rejectedName
    return {
      title: 'New company name needed',
      message: sos
        ? `Unfortunately "${a.rejectedName}" was rejected by the Secretary of State. Please send us a new name so we can check it.`
        : `Unfortunately none of your proposed names are available. Please send us a new name so we can check it.`,
      message_it: sos
        ? `Purtroppo "${a.rejectedName}" è stato rifiutato dal Secretary of State. Inviaci un nuovo nome così possiamo verificarlo.`
        : `Purtroppo nessuno dei nomi proposti è disponibile. Inviaci un nuovo nome così possiamo verificarlo.`,
      options: {
        prompt: 'Please send us a new company name',
        placeholder: 'New Company Name LLC',
        title_it: 'Serve un nuovo nome per la società',
        placeholder_it: 'Nuovo Nome Società LLC',
        required: true,
        name_check: marker,
      },
    }
  }
  const sos = a.reason === 'sos_rejected' && a.rejectedName
  return {
    title: 'New LLC Names Needed',
    message: sos
      ? `Unfortunately "${a.rejectedName}" was rejected by the Secretary of State. Please propose 3 new LLC names so we can check their availability.`
      : `Unfortunately none of your proposed LLC names are available. Please propose 3 new LLC names so we can check their availability.`,
    message_it: sos
      ? `Purtroppo "${a.rejectedName}" è stato rifiutato dal Secretary of State. Proponi 3 nuovi nomi per la tua LLC così possiamo verificarne la disponibilità.`
      : `Purtroppo nessuno dei nomi proposti per la tua LLC è disponibile. Proponi 3 nuovi nomi così possiamo verificarne la disponibilità.`,
    options: {
      prompt: 'Please propose 3 new LLC names',
      placeholder: 'NameOne LLC, NameTwo LLC, NameThree LLC',
      required: true,
      name_check: marker,
    },
  }
}

/** The very first "send us your names" card (services with firstNamesCount > 0), or null. */
export function firstNamesCopy(policy: NameLoopPolicy): DecisionCopy | null {
  if (policy.key !== 'change_name' || policy.firstNamesCount <= 0) return null
  return {
    title: 'Send us the names you would like for your company',
    message:
      `To start the name change, please send us up to ${policy.firstNamesCount} names you would like for your company, one per line, in order of preference. ` +
      `We will check them with the state and come back to you with one that is available.`,
    message_it:
      `Per iniziare il cambio nome, inviaci fino a ${policy.firstNamesCount} nomi che vorresti per la tua società, uno per riga, in ordine di preferenza. ` +
      `Li verificheremo con lo stato e ti proporremo uno disponibile.`,
    options: {
      prompt: 'Your company names (one per line, in order of preference)',
      placeholder: 'First Choice LLC\nSecond Choice LLC\nThird Choice LLC',
      title_it: 'Inviaci i nomi che vorresti per la tua società',
      placeholder_it: 'Prima Scelta LLC\nSeconda Scelta LLC\nTerza Scelta LLC',
      required: true,
      name_check: { kind: 'new_names', split: 'lines', max: policy.firstNamesCount },
    },
  }
}

/** The heads-up message in the client's portal chat when a name is sent for confirmation. */
export function proposalChatNote(
  policy: NameLoopPolicy,
  a: { displayName: string; state: string; language: 'en' | 'it' },
): string {
  if (policy.key === 'change_name') {
    return a.language === 'it'
      ? `Abbiamo verificato ${a.displayName} ed è disponibile in ${a.state}. Ti abbiamo inviato una richiesta di conferma — controlla il tuo portale.`
      : `We checked ${a.displayName} and it is available in ${a.state}. We've sent you a request to confirm — please check your portal.`
  }
  return a.language === 'it'
    ? `Abbiamo verificato i nomi della tua LLC e ${a.displayName} è disponibile in ${a.state}. Ti abbiamo inviato una richiesta di conferma — controlla il tuo portale.`
    : `We checked your LLC names and ${a.displayName} is available in ${a.state}. We've sent you a request to confirm — please check your portal.`
}
