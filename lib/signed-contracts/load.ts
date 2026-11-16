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
import { fetchAllRows } from '@/lib/crm-lists/queries'
import type { CompanyAmountsRow, CompanyLookup } from './company-check'
import { buildEntries, type AgreementRow, type ContractRow, type CorrectionRow, type OfferRow } from './entries'
import { INSTALLMENT_CONTRACT_TYPES, hasInstallmentAmounts } from './labels'
import { contractMismatchesByCompany, contractMismatchesByPerson, type MismatchPerson, type OfferWithOwners } from './list-mismatches'
import { AMOUNTS_CORRECTED_ACTION, type ContractMismatch, type SignedContractEntry } from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

const OFFER_COLUMNS = 'id, token, contract_type, installment_currency, recurring_costs, account_id'
const CONTRACT_COLUMNS = 'id, offer_token, signed_at, created_at, updated_at, contract_version, annual_fee, installments, pdf_path'
/** the company's own installment amounts (what the CRM shows) — nothing else of the company is read */
const COMPANY_COLUMNS = 'id, installment_1_amount, installment_1_currency, installment_2_amount, installment_2_currency'

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

/**
 * The companies the signed formation / onboarding offers are filed on, for the "does the company agree with the contract" note.
 * A failed read NEVER hides a contract and never claims a match: it is reported as `failed` and the line says it could not compare.
 */
async function lookUpCompanies(offers: OfferRow[], contracts: ContractRow[]): Promise<CompanyLookup> {
  const signed = new Set(contracts.map((c) => c.offer_token))
  const ids = Array.from(
    new Set(
      offers
        .filter((o) => o.contract_type !== 'renewal' && hasInstallmentAmounts(o.contract_type) && o.account_id && signed.has(o.token))
        .map((o) => o.account_id as string),
    ),
  )
  const byId = new Map<string, CompanyAmountsRow>()
  if (ids.length === 0) return { kind: 'ok', byId }
  try {
    const res = await db.from('accounts').select(COMPANY_COLUMNS).in('id', ids)
    if (res.error) throw new Error(res.error.message)
    for (const row of (res.data ?? []) as CompanyAmountsRow[]) byId.set(row.id, row)
    return { kind: 'ok', byId }
  } catch (err) {
    console.error('[signed-contracts] the companies could not be read for the amount check:', err instanceof Error ? err.message : err)
    return { kind: 'failed' }
  }
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
  const [companies, agreementsRes, correctionsRes] = await Promise.all([
    lookUpCompanies(offers, contracts),
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
    companies,
  })
}

export async function loadSignedContractsForContact(contactId: string, email: string | null): Promise<SignedContractEntry[]> {
  return assemble(await offersFor(contactId, email))
}

/** What the Contacts list gets: the amber findings per person, or `failed` (never an empty answer that looks like "all fine"). */
export type ContractMismatchLoad = { kind: 'ok'; byPerson: Map<string, ContractMismatch[]> } | { kind: 'failed' }

/** The offers whose contracts are compared with the company: formation and onboarding (renewals keep their amounts on the agreement). */
const COMPARED_OFFER_TYPES = INSTALLMENT_CONTRACT_TYPES.filter((t) => t !== 'renewal')
/** the offer columns that say whose it is, on top of what the card's lines read */
const OFFER_OWNER_COLUMNS = `${OFFER_COLUMNS}, contact_id, client_email, lead_id`
/** a short list of tokens per request keeps the address of each request small */
const TOKENS_PER_REQUEST = 100

/** The signed contracts of these offers, read in short batches of tokens. A failed read throws (the callers turn that into `failed`). */
async function readContractsOf(offers: OfferRow[]): Promise<ContractRow[]> {
  const tokens = offers.map((o) => o.token).filter(Boolean)
  const chunks: string[][] = []
  for (let i = 0; i < tokens.length; i += TOKENS_PER_REQUEST) chunks.push(tokens.slice(i, i + TOKENS_PER_REQUEST))
  const results = await Promise.all(chunks.map((chunk) => db.from('contracts').select(CONTRACT_COLUMNS).in('offer_token', chunk)))
  const contracts: ContractRow[] = []
  for (const r of results) {
    if (r.error) throw new Error(`Could not read the signed contracts: ${r.error.message}`)
    contracts.push(...((r.data ?? []) as ContractRow[]))
  }
  return contracts
}

/**
 * For the Contacts list: which of these people have a signed contract that does not match their company (the amber note on the Contact
 * page). ONE bulk read, not the card's per-person lookup: the offers that can be compared are few (formation + onboarding), so they are
 * read once with their contracts and matched to the people in memory by the card's own four rules (see `list-mismatches.ts`).
 * Any failed read returns `failed` so the list can say so, instead of showing nobody amber as if everything matched.
 */
export async function loadContractMismatchesForPeople(input: { people: MismatchPerson[]; companyNames: Map<string, string> }): Promise<ContractMismatchLoad> {
  if (input.people.length === 0) return { kind: 'ok', byPerson: new Map() }
  try {
    const [offers, leads] = await Promise.all([
      fetchAllRows<OfferWithOwners>((from, to) =>
        db.from('offers').select(OFFER_OWNER_COLUMNS).in('contract_type', COMPARED_OFFER_TYPES).order('id', { ascending: true }).range(from, to),
      ),
      db.from('leads').select('id, converted_to_contact_id').in('converted_to_contact_id', input.people.map((p) => p.id)),
    ])
    if (leads.error) throw new Error(`Could not read the leads of these people: ${leads.error.message}`)
    const leadPerson = new Map<string, string>()
    for (const l of (leads.data ?? []) as { id: string; converted_to_contact_id: string | null }[]) {
      if (l.converted_to_contact_id) leadPerson.set(l.id, l.converted_to_contact_id)
    }

    const contracts = await readContractsOf(offers)
    const companies = await lookUpCompanies(offers, contracts)
    if (companies.kind === 'failed') return { kind: 'failed' }
    return { kind: 'ok', byPerson: contractMismatchesByPerson({ ...input, leadPerson, offers, contracts, companies }) }
  } catch (err) {
    console.error('[signed-contracts] the contract amount check for the Contacts list could not run:', err instanceof Error ? err.message : err)
    return { kind: 'failed' }
  }
}

/** What the Accounts list and the company page get: the amber findings per company, or `failed` (never an empty answer that looks like "all fine"). */
export type CompanyMismatchLoad = { kind: 'ok'; byCompany: Map<string, ContractMismatch[]> } | { kind: 'failed' }

/** a short list of companies per request keeps the address of each request small */
const COMPANIES_PER_REQUEST = 100

/**
 * For the Accounts list and the company page: which of these companies have a signed contract whose amounts do not match the company's
 * own installment amounts (the same amber finding as on the Contact page and the Contacts list — see `list-mismatches.ts`). Only the
 * formation / onboarding offers FILED ON these companies are read, with their contracts and the companies' installment columns; nothing
 * else. Any failed read returns `failed`, so a screen can say so instead of showing no company amber as if everything matched.
 */
export async function loadContractMismatchesForCompanies(input: { accountIds: string[]; companyNames: Map<string, string> }): Promise<CompanyMismatchLoad> {
  if (input.accountIds.length === 0) return { kind: 'ok', byCompany: new Map() }
  try {
    const chunks: string[][] = []
    for (let i = 0; i < input.accountIds.length; i += COMPANIES_PER_REQUEST) chunks.push(input.accountIds.slice(i, i + COMPANIES_PER_REQUEST))
    const results = await Promise.all(
      chunks.map((chunk) => db.from('offers').select(OFFER_COLUMNS).in('account_id', chunk).in('contract_type', COMPARED_OFFER_TYPES)),
    )
    const offers: OfferRow[] = []
    for (const r of results) {
      if (r.error) throw new Error(`Could not read the offers of these companies: ${r.error.message}`)
      offers.push(...((r.data ?? []) as OfferRow[]))
    }
    if (offers.length === 0) return { kind: 'ok', byCompany: new Map() }

    const contracts = await readContractsOf(offers)
    const companies = await lookUpCompanies(offers, contracts)
    if (companies.kind === 'failed') return { kind: 'failed' }
    return { kind: 'ok', byCompany: contractMismatchesByCompany({ ...input, offers, contracts, companies }) }
  } catch (err) {
    console.error('[signed-contracts] the contract amount check for the companies could not run:', err instanceof Error ? err.message : err)
    return { kind: 'failed' }
  }
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
