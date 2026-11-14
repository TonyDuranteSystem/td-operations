/**
 * "How they became our client" on an account: Formed by us | Onboarded (dev job 5ea6c651).
 *
 * Both words come from the offer / contract type: a company we FORMED bought a formation contract, a company that already existed
 * and moved to us bought an onboarding contract. Existing companies get a GUESS that a person confirms one by one; until then it is
 * shown as "To check". Pure — client-safe, no database.
 *
 * The guess order is the same as the SQL backfill in scripts/migrations/20261114-0400-account-became-client-how.sql:
 *   1. a signed formation contract (and no onboarding one)  -> formed_by_us
 *   2. a signed onboarding contract (and no formation one)  -> onboarded
 *   3. otherwise Client Since filled -> onboarded, empty -> formed_by_us
 */

export const BECAME_CLIENT_VALUES = ['formed_by_us', 'onboarded'] as const
export type BecameClientHow = (typeof BECAME_CLIENT_VALUES)[number]

export const BECAME_CLIENT_LABEL: Record<BecameClientHow, string> = {
  formed_by_us: 'Formed by us',
  onboarded: 'Onboarded',
}

export function isBecameClientHow(v: unknown): v is BecameClientHow {
  return typeof v === 'string' && (BECAME_CLIENT_VALUES as readonly string[]).includes(v)
}

/** "Formed by us", "Onboarded", or "Not set" for an empty / unknown value. */
export function becameClientLabel(v: string | null | undefined): string {
  return isBecameClientHow(v) ? BECAME_CLIENT_LABEL[v] : 'Not set'
}

export interface BecameClientFacts {
  /** which signed contracts are linked to the account */
  hasSignedFormationContract: boolean
  hasSignedOnboardingContract: boolean
  /** the day the (formation or onboarding) contract was signed, YYYY-MM-DD, when there is exactly one kind */
  contractSignedAt: string | null
  clientSince: string | null
  /** a Company Formation job exists for the account */
  hasFormationJob: boolean
}

export type GuessBasis = 'contract' | 'dates' | 'conflict'

export interface BecameClientGuess {
  value: BecameClientHow
  basis: GuessBasis
  /** one plain sentence saying where the guess comes from */
  hint: string
}

const prettyDate = (iso: string | null): string => {
  if (!iso) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return iso
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const month = months[Number(m[2]) - 1]
  return month ? `${month} ${Number(m[3])}, ${m[1]}` : iso
}

export function guessBecameClient(f: BecameClientFacts): BecameClientGuess {
  const onlyFormation = f.hasSignedFormationContract && !f.hasSignedOnboardingContract
  const onlyOnboarding = f.hasSignedOnboardingContract && !f.hasSignedFormationContract
  const when = f.contractSignedAt ? ` (${prettyDate(f.contractSignedAt)})` : ''

  if (onlyFormation) {
    return { value: 'formed_by_us', basis: 'contract', hint: `The signed formation contract${when} says we formed it.` }
  }
  if (onlyOnboarding) {
    return { value: 'onboarded', basis: 'contract', hint: `The signed onboarding contract${when} says it already existed.` }
  }

  const clientSinceFilled = !!f.clientSince
  const value: BecameClientHow = clientSinceFilled ? 'onboarded' : 'formed_by_us'
  const bothContracts = f.hasSignedFormationContract && f.hasSignedOnboardingContract
  const prefix = bothContracts ? 'Both a formation and an onboarding contract are signed, so this comes from the dates. ' : ''

  if (clientSinceFilled && f.hasFormationJob) {
    return { value, basis: 'conflict', hint: `${prefix}Client Since is filled in (usually onboarded), but we also have a company formation job for it.` }
  }
  if (!clientSinceFilled && !f.hasFormationJob) {
    return { value, basis: 'conflict', hint: `${prefix}Client Since is empty (usually formed by us), but we have no company formation job for it.` }
  }
  return {
    value,
    basis: 'dates',
    hint: clientSinceFilled
      ? `${prefix}Client Since is filled in, which usually means it already existed (onboarded).`
      : `${prefix}Client Since is empty and we have a formation job, which usually means we formed it.`,
  }
}

/** The amber line in the pop-up when the new answer does not fit Client Since, or null when it does. */
export function changeHeadsUp(to: BecameClientHow, clientSince: string | null): string | null {
  if (to === 'formed_by_us' && clientSince) {
    return 'Client Since is filled in, and that usually means the company was onboarded, not formed by us.'
  }
  if (to === 'onboarded' && !clientSince) {
    return 'Client Since is empty, and that usually means we formed the company. Check that this one already existed before it came to us.'
  }
  return null
}

/** "dashboard:antonio.durante" -> "antonio.durante" */
export function checkedByName(by: string | null | undefined): string {
  return (by ?? '').replace(/^dashboard:/, '').trim()
}
