/**
 * Server side: the facts the "How they became our client" guess is read from — the signed formation / onboarding contract linked to the
 * account (through its offer) and whether a Company Formation job exists. Needed for every client company whose answer nobody has
 * checked yet (the page computes the guess on every view; nothing is stored until a person confirms or changes it).
 * Reads only; a failed read throws with its real cause (the page then says the contract could not be read, instead of guessing).
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import { etDay, type BecameClientFacts } from './became-client'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function loadBecameClientFacts(accountId: string, clientSince: string | null): Promise<BecameClientFacts> {
  // the offers and the formation-job check do not depend on each other
  const [offersRes, jobRes] = await Promise.all([
    db.from('offers').select('token, contract_type').eq('account_id', accountId).in('contract_type', ['formation', 'onboarding']),
    db.from('service_deliveries').select('id').eq('account_id', accountId).ilike('service_type', '%formation%').limit(1),
  ])
  if (offersRes.error) throw new Error(`Could not read the offers: ${offersRes.error.message}`)
  if (jobRes.error) throw new Error(`Could not read the service deliveries: ${jobRes.error.message}`)
  const offers = (offersRes.data ?? []) as Array<{ token: string; contract_type: 'formation' | 'onboarding' }>

  let signed: Array<{ offer_token: string; signed_at: string | null }> = []
  if (offers.length > 0) {
    const contractsRes = await db.from('contracts').select('offer_token, signed_at').in('offer_token', offers.map((o) => o.token))
    if (contractsRes.error) throw new Error(`Could not read the signed contracts: ${contractsRes.error.message}`)
    signed = (contractsRes.data ?? []) as typeof signed
  }

  const typeOf = new Map(offers.map((o) => [o.token, o.contract_type]))
  const formation = signed.filter((c) => typeOf.get(c.offer_token) === 'formation')
  const onboarding = signed.filter((c) => typeOf.get(c.offer_token) === 'onboarding')
  const onlyOne = (formation.length > 0) !== (onboarding.length > 0)
  const dates = (onlyOne ? (formation.length > 0 ? formation : onboarding) : [])
    .map((c) => etDay(c.signed_at) ?? '')
    .filter(Boolean)
    .sort()

  return {
    hasSignedFormationContract: formation.length > 0,
    hasSignedOnboardingContract: onboarding.length > 0,
    contractSignedAt: dates[0] ?? null,
    clientSince,
    hasFormationJob: (jobRes.data ?? []).length > 0,
  }
}
