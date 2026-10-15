/**
 * New Calendar — the loader (dev job 40235e3c). SERVER-ONLY, READ-ONLY.
 *
 * Everything the Open services loader reads (the open jobs, the step settings, the service cards, the companies and
 * people), plus ONE more read: the jobs finished in the last CLOSED_WINDOW_DAYS days for the Closed list. It demands the
 * same access proof only `requireOpenServicesAccess()` can create, and THROWS on any read error: a half-read must never
 * render as an empty "all clear" — the page catches the throw and shows "Could not load".
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import type { OpenServicesAccessGranted } from "@/lib/open-services/audience"
import type { AccountInput, ContactInput } from "@/lib/open-services/build"
import { CHUNK, PAGE, chunk, loadOpenServicesInputs, readAll, unique, type OpenServicesInputs } from "@/lib/open-services/load"
import { CLOSED_WINDOW_DAYS } from "@/lib/new-calendar/types"
import type { ClosedJobInput } from "@/lib/new-calendar/build"

const DAY_MS = 86_400_000

export interface NewCalendarInputs extends OpenServicesInputs {
  closed: ClosedJobInput[]
}

export async function loadNewCalendarInputs(access: OpenServicesAccessGranted, now: Date = new Date()): Promise<NewCalendarInputs> {
  // The proof is checked at run time as well as by the type: no proof, no data.
  if (!access || access.ok !== true) throw new Error("new-calendar: access not granted")

  const base = await loadOpenServicesInputs(access)

  // One day more than the window: the builder makes the exact cut with the same date it shows on the row.
  const since = new Date(now.getTime() - (CLOSED_WINDOW_DAYS + 1) * DAY_MS)
  const sinceIso = since.toISOString()
  const sinceDate = sinceIso.slice(0, 10)

  const closed = await readAll<ClosedJobInput>("finished jobs", after => {
    let q = supabaseAdmin
      .from("service_deliveries")
      .select("id, service_type, stage, account_id, contact_id, is_test, service_type_entry_id, end_date, stage_entered_at")
      .ilike("status", "completed")
      .or(`end_date.gte.${sinceDate},stage_entered_at.gte.${sinceIso}`)
      .order("id")
      .limit(PAGE)
    if (after) q = q.gt("id", after)
    return q as unknown as PromiseLike<{ data: ClosedJobInput[] | null; error: { message: string } | null }>
  })

  // Names for the finished jobs that were not already loaded with the open ones.
  const haveAccounts = new Set(base.accounts.map(a => a.id))
  const haveContacts = new Set(base.contacts.map(c => c.id))
  const accountIds = unique(closed.map(j => j.account_id)).filter(id => !haveAccounts.has(id))
  const contactIds = unique(closed.filter(j => !j.account_id).map(j => j.contact_id)).filter(id => !haveContacts.has(id))

  const [accountChunks, contactChunks] = await Promise.all([
    Promise.all(
      chunk(accountIds, CHUNK).map(async ids => {
        const { data, error } = await supabaseAdmin
          .from("accounts")
          .select("id, company_name, is_test, is_internal, status")
          .in("id", ids)
        if (error) throw new Error(`new-calendar: could not read companies: ${error.message}`)
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
        if (error) throw new Error(`new-calendar: could not read people: ${error.message}`)
        return (data ?? []) as unknown as ContactInput[]
      }),
    ),
  ])

  return {
    ...base,
    accounts: [...base.accounts, ...accountChunks.flat()],
    contacts: [...base.contacts, ...contactChunks.flat()],
    closed,
  }
}
