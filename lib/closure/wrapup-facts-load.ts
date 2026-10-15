/**
 * Company Closure — loads the facts for the Wrap-up panel (read-only). See lib/closure/wrapup-facts.ts for the rules.
 *
 * Every section is read on its own and fails on its own: a payments query that errors must show "Couldn't check the payments"
 * and keep the close off, never read as "nothing owed" (council, 2026-10-15: the status dialog's fail-open preview is the
 * antipattern). Nothing here writes. The company's EIN is read only to find companies it is a member of and is never returned.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { getOfficeDateString } from '@/lib/portal/office-hours'
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

/** EIN written with or without the dash; the members table keeps whatever was typed. */
function einVariants(ein: string | null | undefined): string[] {
  const digits = (ein ?? '').replace(/\D/g, '')
  if (digits.length !== 9) return []
  return Array.from(new Set([ein!.trim(), digits, `${digits.slice(0, 2)}-${digits.slice(2)}`]))
}

export async function loadWrapUpFacts(deliveryId: string): Promise<LoadResult> {
  const { data: job, error: jobErr } = await supabaseAdmin
    .from('service_deliveries')
    .select('id, service_type, status, account_id, contact_id')
    .eq('id', deliveryId)
    .maybeSingle()
  if (jobErr) return { ok: false, status: 500, error: `Could not read the job. (${jobErr.message})` }
  if (!job) return { ok: false, status: 404, error: 'Job not found.' }
  if (job.service_type !== 'Company Closure') return { ok: false, status: 400, error: 'This is not a Company Closure job.' }

  const checkedAt = new Date().toISOString()
  if (!job.account_id) return { ok: true, facts: await loadPersonFacts(job.contact_id, checkedAt) }

  const { data: account, error: acctErr } = await supabaseAdmin.from('accounts').select(ACCOUNT_COLUMNS).eq('id', job.account_id).maybeSingle()
  if (acctErr) return { ok: false, status: 500, error: `Could not read the company. (${acctErr.message})` }
  if (!account) return { ok: false, status: 404, error: 'The company on this job was not found.' }
  const acct = account as unknown as RawAccount
  const today = getOfficeDateString()

  const leases = await section('the lease', async () =>
    buildLease(acct, must(await supabaseAdmin.from('lease_agreements').select('id, status, suite_number, term_end_date').eq('account_id', acct.id)) as unknown as RawLease[], today),
  )

  const jobsRaw = await section('the open services', async () => {
    const rows = must(
      await supabaseAdmin.from('service_deliveries').select('id, service_type, stage, stage_order, status, due_date').eq('account_id', acct.id),
    ) as unknown as RawJob[]
    const types = Array.from(new Set(rows.map((r) => r.service_type)))
    const first: Record<string, number> = {}
    if (types.length) {
      const stages = must(await supabaseAdmin.from('pipeline_stages').select('service_type, stage_order').in('service_type', types)) as unknown as { service_type: string; stage_order: number }[]
      for (const s of stages) if (first[s.service_type] === undefined || s.stage_order < first[s.service_type]) first[s.service_type] = s.stage_order
    }
    return buildJobs(rows, first, deliveryId)
  })
  const jobs: SectionResult<WrapUpJob[]> = jobsRaw

  const renewals: SectionResult<ReturnType<typeof buildRenewals>> = jobsRaw.ok === false ? { ok: false, error: jobsRaw.error } : { ok: true, data: buildRenewals(acct, jobsRaw.data) }

  const money = await section('the payments', async () =>
    buildMoney(
      must(
        await supabaseAdmin
          .from('payments')
          .select('id, description, invoice_number, status, invoice_status, total, amount, amount_paid, amount_due, amount_currency, credit_remaining')
          .eq('account_id', acct.id)
          .order('created_at', { ascending: false })
          .limit(1000),
      ) as unknown as RawPayment[],
    ),
  )

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
      await supabaseAdmin.from('account_contacts').select('contact_id, account_id').in('contact_id', ids).neq('account_id', acct.id).is('ended_at', null),
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
    const variants = einVariants(acct.ein_number)
    if (variants.length === 0) return buildMemberships([])
    const rows = must(
      await supabaseAdmin.from('members').select('account_id, ownership_pct').in('ein', variants).neq('account_id', acct.id),
    ) as unknown as { account_id: string; ownership_pct: number | null }[]
    if (rows.length === 0) return buildMemberships([])
    const parents = must(await supabaseAdmin.from('accounts').select('id, company_name, status').in('id', Array.from(new Set(rows.map((r) => r.account_id))))) as unknown as {
      id: string
      company_name: string | null
      status: string | null
    }[]
    const raw: RawMembership[] = rows.map((r) => {
      const p = parents.find((x) => x.id === r.account_id)
      return { company_name: p?.company_name ?? null, status: p?.status ?? null, ownership_pct: r.ownership_pct }
    })
    return buildMemberships(raw)
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
    holds: buildHolds({ tax, money }),
  }
  return { ok: true, facts }
}

/** A closure with no company record (the client's new company is NOT the one being closed — see closure-subject.ts). */
async function loadPersonFacts(contactId: string | null, checkedAt: string): Promise<WrapUpPersonFacts> {
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
    const { data: contact } = await supabaseAdmin.from('contacts').select('full_name, email, language').eq('id', contactId).maybeSingle()
    if (contact) base.person = { name: contact.full_name?.trim() || 'Unnamed person', email: contact.email?.trim() || null, languageLabel: contact.language?.trim() || null }
    const { data: subs } = await supabaseAdmin
      .from('closure_submissions')
      .select('submitted_data, created_at')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false })
      .limit(1)
    const data = (subs?.[0]?.submitted_data ?? null) as Record<string, unknown> | null
    if (data) {
      const str = (k: string) => (typeof data[k] === 'string' && (data[k] as string).trim() ? (data[k] as string).trim() : null)
      base.closureCompanyName = str('llc_name')
      base.closureCompanyState = str('llc_state')
      base.returnsFiledText = [str('tax_returns_filed'), str('tax_returns_years')].filter(Boolean).join(' · ') || null
    }
    const { data: links } = await supabaseAdmin.from('account_contacts').select('account_id').eq('contact_id', contactId).is('ended_at', null)
    const ids = (links ?? []).map((l) => l.account_id as string)
    if (ids.length) {
      const { data: accts } = await supabaseAdmin.from('accounts').select('company_name, status').in('id', ids)
      base.personCompanies = (accts ?? []).map((a) => ({ name: a.company_name?.trim() || 'Unnamed company', status: a.status ?? null }))
    }
  } catch {
    // The person variant is informational only; a failed read leaves the fields empty and the panel says so.
    base.readFailed = true
  }
  return base
}
