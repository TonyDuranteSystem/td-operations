/**
 * Database side of "who referred this client" for STAFF screens (dev job bea928e0). The pure rules live in
 * ./referral-source.ts; this file only fetches. Read-only — it never writes anything.
 *
 * Staff only: the Finance invoice list, the company page and the Add-referral screen. Never import this from a
 * client-portal route.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { SIGNED_OFFER_STATUSES, offerReferrerName, offerTokenOfInvoice } from "@/lib/referrals/referral-source"

const CHUNK = 100

function chunk<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Company name / person name for a set of ids (used only when an offer points at a referrer by id with no typed name). */
async function resolveActorNames(accountIds: string[], contactIds: string[]) {
  const accounts = new Map<string, string>()
  const contacts = new Map<string, string>()
  for (const ids of chunk(Array.from(new Set(accountIds)))) {
    const { data } = await supabaseAdmin.from("accounts").select("id, company_name").in("id", ids)
    for (const a of (data ?? []) as Array<{ id: string; company_name: string | null }>) if (a.company_name) accounts.set(a.id, a.company_name)
  }
  for (const ids of chunk(Array.from(new Set(contactIds)))) {
    const { data } = await supabaseAdmin.from("contacts").select("id, full_name").in("id", ids)
    for (const c of (data ?? []) as Array<{ id: string; full_name: string | null }>) if (c.full_name) contacts.set(c.id, c.full_name)
  }
  return { accounts, contacts }
}

interface OfferReferrerRow {
  token: string
  referrer_name: string | null
  referrer_account_id: string | null
  referrer_contact_id: string | null
}

/**
 * For invoices: offer token → referrer's name, for every token whose offer has a referrer. A token missing from the
 * map has no referrer (or no offer). The name may be "" only when nothing could be resolved for an id-only referrer.
 */
export async function referrerNamesByOfferToken(tokens: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  const unique = Array.from(new Set(tokens.filter(Boolean)))
  const rows: OfferReferrerRow[] = []
  for (const ids of chunk(unique)) {
    const { data } = await supabaseAdmin
      .from("offers")
      .select("token, referrer_name, referrer_account_id, referrer_contact_id")
      .in("token", ids)
    rows.push(...((data ?? []) as OfferReferrerRow[]))
  }

  const idOnly = rows.filter((r) => offerReferrerName(r) === "")
  const names = idOnly.length
    ? await resolveActorNames(idOnly.map((r) => r.referrer_account_id).filter((v): v is string => !!v), idOnly.map((r) => r.referrer_contact_id).filter((v): v is string => !!v))
    : { accounts: new Map<string, string>(), contacts: new Map<string, string>() }

  for (const r of rows) {
    const name = offerReferrerName(r)
    if (name === null) continue
    const resolved = name || (r.referrer_account_id ? names.accounts.get(r.referrer_account_id) : undefined) || (r.referrer_contact_id ? names.contacts.get(r.referrer_contact_id) : undefined) || ""
    result.set(r.token, resolved)
  }
  return result
}

/** The invoices-list helper: invoice id → referrer name, only for invoices whose offer has a referrer. */
export async function referrerNamesByInvoice(
  invoices: Array<{ id: string; idempotency_key?: string | null; tranche_offer_token?: string | null }>,
): Promise<Map<string, string>> {
  const tokenOf = new Map<string, string>()
  for (const inv of invoices) {
    const token = offerTokenOfInvoice(inv)
    if (token) tokenOf.set(inv.id, token)
  }
  if (tokenOf.size === 0) return new Map()
  const byToken = await referrerNamesByOfferToken(Array.from(tokenOf.values()))
  const out = new Map<string, string>()
  for (const [invoiceId, token] of Array.from(tokenOf.entries())) {
    const name = byToken.get(token)
    if (name !== undefined) out.set(invoiceId, name)
  }
  return out
}

export interface SignedOfferRow extends OfferReferrerRow {
  created_at: string | null
  cost_summary: unknown
  account_id: string | null
}

const SIGNED_OFFER_COLUMNS = "token, created_at, cost_summary, account_id, referrer_name, referrer_account_id, referrer_contact_id"

/**
 * The offers each company SIGNED, found three ways because the offer does not always carry the company:
 *   1. the offer names the company itself;
 *   2. the invoice raised at signing / for a plan part points back at the offer (exact — the money went to this company);
 *   3. the offer was made to a person, and has no company yet (only then is the person used — never when the offer
 *      already names a company, so a person who owns two companies cannot lend one company's offer to the other).
 */
export async function signedOffersForAccounts(accountIds: string[]): Promise<Map<string, SignedOfferRow[]>> {
  const result = new Map<string, Map<string, SignedOfferRow>>()
  const add = (accountId: string, offer: SignedOfferRow) => {
    if (!result.has(accountId)) result.set(accountId, new Map())
    result.get(accountId)!.set(offer.token, offer)
  }
  const ids = Array.from(new Set(accountIds.filter(Boolean)))
  if (ids.length === 0) return new Map()

  // 1. offers that name the company
  for (const part of chunk(ids)) {
    const { data } = await supabaseAdmin.from("offers").select(SIGNED_OFFER_COLUMNS).in("account_id", part).in("status", [...SIGNED_OFFER_STATUSES])
    for (const o of (data ?? []) as SignedOfferRow[]) if (o.account_id) add(o.account_id, o)
  }

  // 2. offers reached through the company's own invoices
  const tokenAccounts = new Map<string, Set<string>>()
  for (const part of chunk(ids)) {
    const { data } = await supabaseAdmin
      .from("payments")
      .select("account_id, idempotency_key, tranche_offer_token")
      .in("account_id", part)
      .or("idempotency_key.like.offer-signed:%,tranche_offer_token.not.is.null")
    for (const p of (data ?? []) as Array<{ account_id: string | null; idempotency_key: string | null; tranche_offer_token: string | null }>) {
      const token = offerTokenOfInvoice(p)
      if (!token || !p.account_id) continue
      if (!tokenAccounts.has(token)) tokenAccounts.set(token, new Set())
      tokenAccounts.get(token)!.add(p.account_id)
    }
  }
  for (const part of chunk(Array.from(tokenAccounts.keys()))) {
    const { data } = await supabaseAdmin.from("offers").select(SIGNED_OFFER_COLUMNS).in("token", part).in("status", [...SIGNED_OFFER_STATUSES])
    for (const o of (data ?? []) as SignedOfferRow[]) for (const accountId of Array.from(tokenAccounts.get(o.token) ?? [])) add(accountId, o)
  }

  // 3. person-only offers (no company on the offer)
  const contactAccounts = new Map<string, string[]>()
  for (const part of chunk(ids)) {
    const { data } = await supabaseAdmin.from("account_contacts").select("account_id, contact_id").in("account_id", part)
    for (const l of (data ?? []) as Array<{ account_id: string; contact_id: string }>) {
      if (!contactAccounts.has(l.contact_id)) contactAccounts.set(l.contact_id, [])
      contactAccounts.get(l.contact_id)!.push(l.account_id)
    }
  }
  for (const part of chunk(Array.from(contactAccounts.keys()))) {
    const { data } = await supabaseAdmin
      .from("offers")
      .select(`${SIGNED_OFFER_COLUMNS}, contact_id`)
      .in("contact_id", part)
      .is("account_id", null)
      .in("status", [...SIGNED_OFFER_STATUSES])
    for (const o of (data ?? []) as Array<SignedOfferRow & { contact_id: string | null }>) {
      // A person who sits on several of the companies we were asked about cannot be pinned to one — skip, never guess.
      const owners = o.contact_id ? Array.from(new Set(contactAccounts.get(o.contact_id) ?? [])) : []
      if (owners.length === 1) add(owners[0], o)
    }
  }

  const out = new Map<string, SignedOfferRow[]>()
  for (const [accountId, offers] of Array.from(result.entries())) out.set(accountId, Array.from(offers.values()))
  return out
}

function addUnique(list: string[], name: string | null | undefined) {
  const clean = (name ?? "").trim()
  if (!clean) return
  if (!list.some((n) => n.toLowerCase() === clean.toLowerCase())) list.push(clean)
}

/**
 * "Referred by …" for the company page: who brought this company to us. Reads, in order of trust, the offers the
 * company signed (the exact source), then the referral records (covers a referral staff added by hand), then the
 * lead the person came from. Returns every distinct name found, [] when the company was not referred.
 */
export async function referredByForAccount(accountId: string): Promise<string[]> {
  const names: string[] = []

  // 1. signed offers
  const offers = (await signedOffersForAccounts([accountId])).get(accountId) ?? []
  const idOnly = offers.filter((o) => offerReferrerName(o) === "")
  const resolved = idOnly.length
    ? await resolveActorNames(idOnly.map((o) => o.referrer_account_id).filter((v): v is string => !!v), idOnly.map((o) => o.referrer_contact_id).filter((v): v is string => !!v))
    : { accounts: new Map<string, string>(), contacts: new Map<string, string>() }
  for (const o of offers) {
    const typed = offerReferrerName(o)
    if (typed === null) continue
    addUnique(names, typed || (o.referrer_account_id ? resolved.accounts.get(o.referrer_account_id) : undefined) || (o.referrer_contact_id ? resolved.contacts.get(o.referrer_contact_id) : undefined))
  }

  // The company's people (needed by the referral-record and lead bridges below).
  const { data: links } = await supabaseAdmin.from("account_contacts").select("contact_id").eq("account_id", accountId)
  const contactIds = ((links ?? []) as Array<{ contact_id: string }>).map((l) => l.contact_id).filter(Boolean)

  // 2. referral records: pointing at this company, or at one of its people with no company on the record
  const referrerAccountIds: string[] = []
  const referrerContactIds: string[] = []
  const rowQueries = [
    supabaseAdmin.from("referrals").select("referrer_account_id, referrer_contact_id").eq("referred_account_id", accountId).eq("is_test", false),
    ...(contactIds.length
      ? [supabaseAdmin.from("referrals").select("referrer_account_id, referrer_contact_id").is("referred_account_id", null).in("referred_contact_id", contactIds).eq("is_test", false)]
      : []),
  ]
  for (const q of rowQueries) {
    const { data } = await q
    for (const r of (data ?? []) as Array<{ referrer_account_id: string | null; referrer_contact_id: string | null }>) {
      // A client cannot be "referred by" itself (the manual screen refuses it too).
      if (r.referrer_account_id && r.referrer_account_id !== accountId) referrerAccountIds.push(r.referrer_account_id)
      else if (r.referrer_contact_id && !contactIds.includes(r.referrer_contact_id)) referrerContactIds.push(r.referrer_contact_id)
    }
  }
  if (referrerAccountIds.length || referrerContactIds.length) {
    const actors = await resolveActorNames(referrerAccountIds, referrerContactIds)
    for (const id of referrerAccountIds) addUnique(names, actors.accounts.get(id))
    for (const id of referrerContactIds) addUnique(names, actors.contacts.get(id))
  }

  // 3. the lead the person came from — last resort, only when nothing above found a referrer
  if (names.length === 0 && contactIds.length) {
    const { data } = await supabaseAdmin
      .from("leads")
      .select("referrer_name, referrer_account_id, referrer_contact_id")
      .in("converted_to_contact_id", contactIds)
    const leadRows = (data ?? []) as Array<{ referrer_name: string | null; referrer_account_id: string | null; referrer_contact_id: string | null }>
    const leadIdOnly = leadRows.filter((l) => offerReferrerName(l) === "")
    const actors = leadIdOnly.length
      ? await resolveActorNames(leadIdOnly.map((l) => l.referrer_account_id).filter((v): v is string => !!v), leadIdOnly.map((l) => l.referrer_contact_id).filter((v): v is string => !!v))
      : { accounts: new Map<string, string>(), contacts: new Map<string, string>() }
    for (const l of leadRows) {
      const typed = offerReferrerName(l)
      if (typed === null) continue
      addUnique(names, typed || (l.referrer_account_id ? actors.accounts.get(l.referrer_account_id) : undefined) || (l.referrer_contact_id ? actors.contacts.get(l.referrer_contact_id) : undefined))
    }
  }

  return names
}
