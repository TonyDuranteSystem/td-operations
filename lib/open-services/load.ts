/**
 * Open services tab — the loader (N1a C3). SERVER-ONLY, READ-ONLY.
 *
 * Reads with the service client AFTER the guard has passed (the function demands the access proof only
 * `requireOpenServicesAccess()` can create). It THROWS on any read error: a half-read must never render as an empty
 * "all clear" — the page catches the throw and shows "Could not load".
 *
 * Paging: PostgREST silently stops at 1000 rows, so every table is read by keyset (`id > last`, ordered by id) and
 * de-duplicated by id. Name lookups are chunked (`in` lists stay short) and run in parallel.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { TERMINAL_DELIVERY_STATUSES } from "@/lib/services/stages"
import type { OpenServicesAccessGranted } from "@/lib/open-services/audience"
import type {
  AccountInput,
  CardInput,
  ContactInput,
  JobInput,
  StepInput,
} from "@/lib/open-services/build"

const PAGE = 1000
const CHUNK = 100
const MAX_PAGES = 200

export interface OpenServicesInputs {
  jobs: JobInput[]
  steps: StepInput[]
  accounts: AccountInput[]
  contacts: ContactInput[]
  cards: CardInput[]
}

interface PageResult<T> {
  data: T[] | null
  error: { message: string } | null
}

async function readAll<T extends { id: string }>(
  label: string,
  page: (afterId: string | null) => PromiseLike<PageResult<T>>,
): Promise<T[]> {
  const out: T[] = []
  const seen = new Set<string>()
  let after: string | null = null
  for (let i = 0; i < MAX_PAGES; i++) {
    const { data, error } = await page(after)
    if (error) throw new Error(`open-services: could not read ${label}: ${error.message}`)
    const rows = data ?? []
    for (const r of rows) {
      if (!seen.has(r.id)) {
        seen.add(r.id)
        out.push(r)
      }
    }
    if (rows.length < PAGE) return out
    after = rows[rows.length - 1].id
  }
  throw new Error(`open-services: ${label} has more than ${MAX_PAGES * PAGE} rows — refusing to show a partial list`)
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function unique(ids: Array<string | null>): string[] {
  return Array.from(new Set(ids.filter((v): v is string => !!v)))
}

export async function loadOpenServicesInputs(access: OpenServicesAccessGranted): Promise<OpenServicesInputs> {
  // The proof is checked at run time as well as by the type: no proof, no data.
  if (!access || access.ok !== true) throw new Error("open-services: access not granted")

  const terminal = TERMINAL_DELIVERY_STATUSES.join(",")

  const [jobs, steps, cards] = await Promise.all([
    readAll<JobInput>("jobs", after => {
      let q = supabaseAdmin
        .from("service_deliveries")
        .select("id, service_type, stage, status, stage_entered_at, created_at, account_id, contact_id, is_test, service_type_entry_id")
        .or(`status.is.null,status.not.in.(${terminal})`)
        .order("id")
        .limit(PAGE)
      if (after) q = q.gt("id", after)
      return q as unknown as PromiseLike<PageResult<JobInput>>
    }),
    readAll<StepInput & { id: string }>("service steps", after => {
      let q = supabaseAdmin
        .from("pipeline_stages")
        .select("id, service_type, stage_name, stage_order, waiting_on, sla_days, completes_service")
        .order("id")
        .limit(PAGE)
      if (after) q = q.gt("id", after)
      return q as unknown as PromiseLike<PageResult<StepInput & { id: string }>>
    }),
    readAll<CardInput>("service cards", after => {
      let q = supabaseAdmin
        .from("catalog_entries")
        .select("id, display_name, metadata")
        .eq("catalog_id", "services")
        .or("metadata->>closes_only_by_filing.eq.true,metadata->>hidden_from_open_services.eq.true")
        .order("id")
        .limit(PAGE)
      if (after) q = q.gt("id", after)
      return q as unknown as PromiseLike<PageResult<CardInput>>
    }),
  ])

  // The renewals rule is live (C0): its cards must exist. If none come back, the exclusion would silently do nothing
  // and renewals would flood the tab — refuse instead of guessing.
  const hasRenewalCard = cards.some(c => c.metadata?.closes_only_by_filing === true || c.metadata?.closes_only_by_filing === "true")
  if (!hasRenewalCard) {
    throw new Error("open-services: no service card with closes_only_by_filing was found — the exclusion settings are missing")
  }
  // Same for the tax-return card (migration 20261007-0100): if the page were switched on before that migration ran,
  // every open Tax Return job would silently list. Refuse instead — the message tells whoever opens it what to run.
  const hasTaxHiddenCard = cards.some(c => c.metadata?.hidden_from_open_services === true || c.metadata?.hidden_from_open_services === "true")
  if (!hasTaxHiddenCard) {
    throw new Error("open-services: no service card with hidden_from_open_services was found — run migration 20261007-0100-open-services-hidden-flag first")
  }

  // Company/person details are loaded for EVERY open job, including the ones excluded by a service card: the test /
  // internal flags decide whether an excluded job is counted in the "not shown" line, exactly as for jobs on the tab.
  const accountIds = unique(jobs.map(j => j.account_id))
  const contactIds = unique(jobs.filter(j => !j.account_id).map(j => j.contact_id))

  const [accountChunks, contactChunks] = await Promise.all([
    Promise.all(
      chunk(accountIds, CHUNK).map(async ids => {
        const { data, error } = await supabaseAdmin
          .from("accounts")
          .select("id, company_name, is_test, is_internal, status")
          .in("id", ids)
        if (error) throw new Error(`open-services: could not read companies: ${error.message}`)
        // accounts.is_internal exists in every database but not yet in the generated types — cast through unknown.
        return (data ?? []) as unknown as AccountInput[]
      }),
    ),
    Promise.all(
      chunk(contactIds, CHUNK).map(async ids => {
        const { data, error } = await supabaseAdmin
          .from("contacts")
          .select("id, full_name, is_test")
          .in("id", ids)
        if (error) throw new Error(`open-services: could not read people: ${error.message}`)
        return (data ?? []) as unknown as ContactInput[]
      }),
    ),
  ])

  return {
    jobs,
    steps: steps.map(s => ({
      service_type: s.service_type,
      stage_name: s.stage_name,
      stage_order: s.stage_order,
      waiting_on: s.waiting_on,
      sla_days: s.sla_days,
      completes_service: s.completes_service,
    })),
    accounts: accountChunks.flat(),
    contacts: contactChunks.flat(),
    cards,
  }
}
