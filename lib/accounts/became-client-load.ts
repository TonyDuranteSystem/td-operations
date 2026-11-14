/**
 * Server side: the facts the "How they became our client" guess is read from — the signed formation / onboarding contract linked to the
 * account (through its offer) and whether a Company Formation job exists. Only needed while the answer is still unchecked.
 * Reads only; a failed read throws with its real cause (the page shows the row without a hint rather than guessing).
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import type { BecameClientFacts } from './became-client'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function loadBecameClientFacts(accountId: string, clientSince: string | null): Promise<BecameClientFacts> {
  const offersRes = await db
    .from('offers')
    .select('token, contract_type')
    .eq('account_id', accountId)
    .in('contract_type', ['formation', 'onboarding'])
  if (offersRes.error) throw new Error(`Could not read the offers: ${offersRes.error.message}`)
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
    .map((c) => (c.signed_at ?? '').slice(0, 10))
    .filter(Boolean)
    .sort()

  const jobRes = await db.from('service_deliveries').select('id').eq('account_id', accountId).ilike('service_type', '%formation%').limit(1)
  if (jobRes.error) throw new Error(`Could not read the service deliveries: ${jobRes.error.message}`)

  return {
    hasSignedFormationContract: formation.length > 0,
    hasSignedOnboardingContract: onboarding.length > 0,
    contractSignedAt: dates[0] ?? null,
    clientSince,
    hasFormationJob: (jobRes.data ?? []).length > 0,
  }
}
