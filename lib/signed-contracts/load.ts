/**
 * Server side: which signed contracts belong to a contact, read straight from where they already are
 * (`contracts`, private bucket `signed-contracts`) — nothing is copied or moved.
 *
 * A contract is listed on a contact when its offer was made for that person (offers.contact_id), was sent to their email
 * (offers.client_email), was made from a lead that became that person (leads.converted_to_contact_id), or belongs to a
 * company they are linked to (offers.account_id through account_contacts) — so an annual renewal, which belongs to the
 * company, shows on every person linked to it.
 *
 * Only the columns the card needs are read: never the passport, the address or any other personal field of `contracts`.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import { buildEntries, type AgreementRow, type ContractRow, type CorrectionRow, type OfferRow } from './entries'
import { AMOUNTS_CORRECTED_ACTION, type SignedContractEntry } from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

const OFFER_COLUMNS = 'id, token, contract_type, installment_currency, recurring_costs, account_id'
const CONTRACT_COLUMNS = 'id, offer_token, signed_at, created_at, updated_at, contract_version, annual_fee, installments, pdf_path'

/** Escape a value for ilike so "_" and "%" in an email match themselves. */
const likeEscape = (v: string) => v.replace(/[\\%_]/g, (m) => `\\${m}`)

async function offersFor(contactId: string, email: string | null): Promise<OfferRow[]> {
  const [links, leads] = await Promise.all([
    db.from('account_contacts').select('account_id').eq('contact_id', contactId),
    db.from('leads').select('id').eq('converted_to_contact_id', contactId),
  ])
  // a failed lookup must stop the whole load: treating it as "no companies / no leads" would quietly drop those contracts
  // from the card, or show "No signed contract yet" for a person who has signed
  if (links.error) throw new Error(`Could not read the companies this person is linked to: ${links.error.message}`)
  if (leads.error) throw new Error(`Could not read the leads of this person: ${leads.error.message}`)
  const accountIds: string[] = (links.data ?? []).map((r: { account_id: string }) => r.account_id).filter(Boolean)
  const leadIds: string[] = (leads.data ?? []).map((r: { id: string }) => r.id)

  const queries = [db.from('offers').select(OFFER_COLUMNS).eq('contact_id', contactId)]
  if (email) queries.push(db.from('offers').select(OFFER_COLUMNS).ilike('client_email', likeEscape(email)))
  if (leadIds.length) queries.push(db.from('offers').select(OFFER_COLUMNS).in('lead_id', leadIds))
  if (accountIds.length) queries.push(db.from('offers').select(OFFER_COLUMNS).in('account_id', accountIds))

  const results = await Promise.all(queries)
  const byId = new Map<string, OfferRow>()
  for (const r of results) {
    if (r.error) throw new Error(`Could not read the offers: ${r.error.message}`)
    for (const o of (r.data ?? []) as OfferRow[]) byId.set(o.id, o)
  }
  return Array.from(byId.values())
}

async function assemble(offers: OfferRow[], contractFilter?: { id: string }): Promise<SignedContractEntry[]> {
  const tokens = offers.map((o) => o.token).filter(Boolean)
  if (tokens.length === 0) return []

  let contractQuery = db.from('contracts').select(CONTRACT_COLUMNS).in('offer_token', tokens)
  if (contractFilter) contractQuery = contractQuery.eq('id', contractFilter.id)
  const contractsRes = await contractQuery
  if (contractsRes.error) throw new Error(`Could not read the signed contracts: ${contractsRes.error.message}`)
  const contracts = (contractsRes.data ?? []) as ContractRow[]
  if (contracts.length === 0) return []

  const renewalTokens = offers.filter((o) => o.contract_type === 'renewal').map((o) => o.token)
  const [agreementsRes, correctionsRes] = await Promise.all([
    renewalTokens.length
      ? db.from('annual_agreements').select('token, agreement_year, cost_summary, updated_at').in('token', renewalTokens)
      : Promise.resolve({ data: [] }),
    db
      .from('action_log')
      .select('record_id, created_at, details')
      .eq('action_type', AMOUNTS_CORRECTED_ACTION)
      .in('record_id', contracts.map((c) => c.id))
      .order('created_at', { ascending: false }),
  ])
  if (agreementsRes.error) throw new Error(`Could not read the annual agreements: ${agreementsRes.error.message}`)
  // a missing history never hides a contract: the line just shows without its "corrected by" note
  const corrections = (correctionsRes.error ? [] : correctionsRes.data ?? []) as CorrectionRow[]

  return buildEntries({
    offers,
    contracts,
    agreements: (agreementsRes.data ?? []) as AgreementRow[],
    corrections,
  })
}

export async function loadSignedContractsForContact(contactId: string, email: string | null): Promise<SignedContractEntry[]> {
  return assemble(await offersFor(contactId, email))
}

/** One signing, freshly read — used to answer an edit with the line as it now stands. */
export async function loadSignedContractEntry(contractId: string): Promise<SignedContractEntry | null> {
  const row = await db.from('contracts').select('offer_token').eq('id', contractId).maybeSingle()
  if (row.error) throw new Error(`Could not read the signed contract: ${row.error.message}`)
  const token: string | undefined = row.data?.offer_token
  if (!token) return null
  const offerRes = await db.from('offers').select(OFFER_COLUMNS).eq('token', token)
  if (offerRes.error) throw new Error(`Could not read the offer: ${offerRes.error.message}`)
  const offers = (offerRes.data ?? []) as OfferRow[]
  const entries = await assemble(offers, { id: contractId })
  return entries[0] ?? null
}
