/**
 * Company Closure — loads the facts for the Wrap-up panel (read-only). See lib/closure/wrapup-facts.ts for the rules.
 *
 * Every section is read on its own and fails on its own: a payments query that errors must show "Couldn't check the payments"
 * and keep the close off, never read as "nothing owed" (council, 2026-10-15: the status dialog's fail-open preview is the
 * antipattern). Nothing here writes. The company's EIN is read only to find companies it is a member of and is never returned.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import {
  buildHeader,
  buildHolds,
  buildJobs,
  buildLease,
  buildMemberships,
  buildMoney,
  buildPeople,
  buildRegisteredAgent,
  buildRenewals,
  buildTax,
  type RawAccount,
  type RawJob,
  type RawLease,
  type RawMembership,
  type RawPayment,
  type RawPerson,
  type RawTaxReturn,
  type SectionResult,
  type StageOrders,
  type WrapUpCompanyFacts,
  type WrapUpFacts,
  type WrapUpJob,
  type WrapUpPersonFacts,
} from '@/lib/closure/wrapup-facts'

export type LoadResult = { ok: true; facts: WrapUpFacts } | { ok: false; status: number; error: string }

const ACCOUNT_COLUMNS =
  'id, company_name, state_of_formation, entity_type, status, registered_agent_provider, suite_number, portal_tier, ra_renewal_date, annual_report_due_date, cmra_renewal_date, ein_number, communication_email'

/** A Supabase result → its data, or a thrown error (the client returns errors instead of throwing). */
function must<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message)
  return (res.data ?? ([] as unknown)) as T
}

async function section<T>(what: string, fn: () => Promise<T>): Promise<SectionResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (e) {
    return { ok: false, error: `Couldn't check ${what}.${e instanceof Error && e.message ? ` (${e.message})` : ''}` }
  }
}

/** EIN written with or without the dash; the members table keeps whatever was typed. Only digits and a dash are ever queried (never the raw text). */
function einVariants(ein: string | null | undefined): string[] {
  const digits = (ein ?? '').replace(/\D/g, '')
  if (digits.length !== 9) return []
  return [digits, `${digits.slice(0, 2)}-${digits.slice(2)}`]
}

/** A company name as a members-table text match: exact (case-insensitive), with LIKE wildcards escaped. */
function exactNamePattern(name: string): string {
  return name.trim().replace(/[\\%_]/g, (c) => `\\${c}`)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function loadWrapUpFacts(deliveryId: string): Promise<LoadResult> {
  // A malformed id is simply not a job: answer 404 instead of letting the database reject it as a 500.
  if (!UUID.test(deliveryId)) return { ok: false, status: 404, error: 'Job not found.' }
  const { data: job, error: jobErr } = await supabaseAdmin
    .from('service_deliveries')
    .select('id, service_type, status, account_id, contact_id, source_closure_token')
    .eq('id', deliveryId)
    .maybeSingle()
  if (jobErr) return { ok: false, status: 500, error: `Could not read the job. (${jobErr.message})` }
  if (!job) return { ok: false, status: 404, error: 'Job not found.' }
  if (job.service_type !== 'Company Closure') return { ok: false, status: 400, error: 'This is not a Company Closure job.' }

  const checkedAt = new Date().toISOString()
  if (!job.account_id) return { ok: true, facts: await loadPersonFacts(job.contact_id, job.source_closure_token ?? null, checkedAt) }

  const { data: account, error: acctErr } = await supabaseAdmin.from('accounts').select(ACCOUNT_COLUMNS).eq('id', job.account_id).maybeSingle()
  if (acctErr) return { ok: false, status: 500, error: `Could not read the company. (${acctErr.message})` }
  if (!account) return { ok: false, status: 404, error: 'The company on this job was not found.' }
  const acct = account as unknown as RawAccount
  // The suite is released by a database function that compares with current_date (UTC): use the same date.
  const today = new Date().toISOString().slice(0, 10)

  const leases = await section('the lease', async () =>
    buildLease(acct, must(await supabaseAdmin.from('lease_agreements').select('id, status, suite_number, term_end_date').eq('account_id', acct.id)) as unknown as RawLease[], today),
  )

  const jobsRaw = await section('the open services', async () => {
    const rows = must(
      await supabaseAdmin.from('service_deliveries').select('id, service_type, stage, status, due_date').eq('account_id', acct.id),
    ) as unknown as RawJob[]
    const types = Array.from(new Set(rows.map((r) => r.service_type)))
    const orders: Record<string, StageOrders> = {}
    if (types.length) {
      const stages = must(await supabaseAdmin.from('pipeline_stages').select('service_type, stage_name, stage_order').in('service_type', types)) as unknown as {
        service_type: string
        stage_name: string
        stage_order: number
      }[]
      for (const s of stages) {
        const o = (orders[s.service_type] ??= { first: s.stage_order, byName: {} })
        o.byName[s.stage_name.trim()] = s.stage_order
        if (s.stage_order < o.first) o.first = s.stage_order
      }
    }
    return buildJobs(rows, orders, deliveryId)
  })
  const jobs: SectionResult<WrapUpJob[]> = jobsRaw

  const renewals: SectionResult<ReturnType<typeof buildRenewals>> = jobsRaw.ok === false ? { ok: false, error: jobsRaw.error } : { ok: true, data: buildRenewals(acct, jobsRaw.data) }

  const PAYMENT_LIMIT = 1000
  const money = await section('the payments', async () => {
    const rows = must(
      await supabaseAdmin
        .from('payments')
        .select('id, description, invoice_number, status, invoice_status, total, amount, amount_paid, amount_due, amount_currency, credit_remaining')
        .eq('account_id', acct.id)
        .order('created_at', { ascending: false })
        .limit(PAYMENT_LIMIT),
    ) as unknown as RawPayment[]
    // Never judge "nothing owed" from a list that was cut short.
    if (rows.length >= PAYMENT_LIMIT) throw new Error(`more than ${PAYMENT_LIMIT} payments on this company — review them in Finance`)
    return buildMoney(rows)
  })

  const taxRecords = await section('the tax return records', async () =>
    must(await supabaseAdmin.from('tax_returns').select('tax_year, status, paid').eq('account_id', acct.id)) as unknown as RawTaxReturn[],
  )
  const tax: SectionResult<ReturnType<typeof buildTax>> =
    taxRecords.ok === false
      ? { ok: false, error: taxRecords.error }
      : jobsRaw.ok === false
        ? { ok: false, error: jobsRaw.error }
        : { ok: true, data: buildTax(taxRecords.data, jobsRaw.data) }

  const people = await section('the owners', async () => {
    const links = must(
      await supabaseAdmin.from('account_contacts').select('contact_id, role').eq('account_id', acct.id).is('ended_at', null),
    ) as unknown as { contact_id: string; role: string | null }[]
    if (links.length === 0) return buildPeople([])
    const ids = links.map((l) => l.contact_id)
    const contacts = must(await supabaseAdmin.from('contacts').select('id, full_name, email, language').in('id', ids)) as unknown as {
      id: string
      full_name: string | null
      email: string | null
      language: string | null
    }[]
    const others = must(
      // Same rule as the portal's own company list (lib/portal/queries.ts getPortalAccounts): it does not look at ended_at.
      await supabaseAdmin.from('account_contacts').select('contact_id, account_id').in('contact_id', ids).neq('account_id', acct.id),
    ) as unknown as { contact_id: string; account_id: string }[]
    const otherIds = Array.from(new Set(others.map((o) => o.account_id)))
    const otherAccounts = otherIds.length
      ? (must(await supabaseAdmin.from('accounts').select('id, company_name, status').in('id', otherIds).in('status', ['Active', 'Suspended'])) as unknown as {
          id: string
          company_name: string | null
          status: string | null
        }[])
      : []
    const nameById = new Map(otherAccounts.map((a) => [a.id, a.company_name?.trim() || 'Unnamed company']))
    const rows: RawPerson[] = links.map((l) => {
      const c = contacts.find((x) => x.id === l.contact_id)
      return {
        contact_id: l.contact_id,
        full_name: c?.full_name ?? null,
        email: c?.email ?? null,
        language: c?.language ?? null,
        role: l.role,
        other_portal_companies: others.filter((o) => o.contact_id === l.contact_id && nameById.has(o.account_id)).map((o) => nameById.get(o.account_id) as string),
      }
    })
    return buildPeople(rows)
  })

  const memberOf = await section('which companies this one is a member of', async () => {
    // A company that is a member of another company is recorded on THAT company's member list, by EIN when it was typed and always by name.
    type MemberHit = { id: string; account_id: string; ownership_pct: number | null; end_date: string | null }
    const hits = new Map<string, MemberHit>()
    const variants = einVariants(acct.ein_number)
    if (variants.length) {
      for (const r of must(await supabaseAdmin.from('members').select('id, account_id, ownership_pct, end_date').in('ein', variants).neq('account_id', acct.id)) as unknown as MemberHit[]) hits.set(r.id, r)
    }
    const name = (acct.company_name ?? '').trim()
    if (name) {
      for (const r of must(
        await supabaseAdmin.from('members').select('id, account_id, ownership_pct, end_date').eq('member_type', 'company').ilike('company_name', exactNamePattern(name)).neq('account_id', acct.id),
      ) as unknown as MemberHit[]) hits.set(r.id, r)
    }
    const rows = Array.from(hits.values())
    if (rows.length === 0) return buildMemberships([], today)
    const parents = must(await supabaseAdmin.from('accounts').select('id, company_name, status').in('id', Array.from(new Set(rows.map((r) => r.account_id))))) as unknown as {
      id: string
      company_name: string | null
      status: string | null
    }[]
    const raw: RawMembership[] = rows.map((r) => {
      const p = parents.find((x) => x.id === r.account_id)
      return { company_name: p?.company_name ?? null, status: p?.status ?? null, ownership_pct: r.ownership_pct, end_date: r.end_date }
    })
    return buildMemberships(raw, today)
  })

  const facts: WrapUpCompanyFacts = {
    variant: 'company',
    checkedAt,
    accountId: acct.id,
    header: buildHeader(acct),
    registeredAgent: buildRegisteredAgent(acct),
    portalTier: acct.portal_tier,
    lease: leases,
    renewals,
    jobs,
    money,
    tax,
    people,
    memberOf,
    holds: buildHolds({ tax, money, lease: leases, renewals, jobs, people, memberOf }),
  }
  return { ok: true, facts }
}

/** A closure with no company record (the client's new company is NOT the one being closed — see closure-subject.ts). */
async function loadPersonFacts(contactId: string | null, sourceToken: string | null, checkedAt: string): Promise<WrapUpPersonFacts> {
  const base: WrapUpPersonFacts = {
    variant: 'person',
    checkedAt,
    readFailed: false,
    closureCompanyName: null,
    closureCompanyState: null,
    returnsFiledText: null,
    person: null,
    personCompanies: [],
  }
  if (!contactId) return base
  try {
    const contactRes = await supabaseAdmin.from('contacts').select('full_name, email, language').eq('id', contactId).maybeSingle()
    if (contactRes.error) throw new Error(contactRes.error.message)
    const contact = contactRes.data
    if (contact) base.person = { name: contact.full_name?.trim() || 'Unnamed person', email: contact.email?.trim() || null, languageLabel: contact.language?.trim() || null }

    // The form this job was created from (its own token); a person who closes two companies must not see the other one's form.
    let subQuery = supabaseAdmin.from('closure_submissions').select('submitted_data, created_at').eq('contact_id', contactId)
    if (sourceToken) subQuery = subQuery.eq('token', sourceToken)
    const subRes = await subQuery.order('created_at', { ascending: false }).limit(1)
    if (subRes.error) throw new Error(subRes.error.message)
    const data = (subRes.data?.[0]?.submitted_data ?? null) as Record<string, unknown> | null
    if (data) {
      const str = (k: string) => (typeof data[k] === 'string' && (data[k] as string).trim() ? (data[k] as string).trim() : null)
      base.closureCompanyName = str('llc_name')
      base.closureCompanyState = str('llc_state')
      base.returnsFiledText = [str('tax_returns_filed'), str('tax_returns_years')].filter(Boolean).join(' · ') || null
    }

    const linksRes = await supabaseAdmin.from('account_contacts').select('account_id').eq('contact_id', contactId).is('ended_at', null)
    if (linksRes.error) throw new Error(linksRes.error.message)
    const ids = (linksRes.data ?? []).map((l) => l.account_id as string)
    if (ids.length) {
      const acctRes = await supabaseAdmin.from('accounts').select('company_name, status').in('id', ids)
      if (acctRes.error) throw new Error(acctRes.error.message)
      base.personCompanies = (acctRes.data ?? []).map((a) => ({ name: a.company_name?.trim() || 'Unnamed company', status: a.status ?? null }))
    }
  } catch {
    // Informational only: a failed read leaves the fields empty and the panel says the facts are incomplete.
    base.readFailed = true
  }
  return base
}
