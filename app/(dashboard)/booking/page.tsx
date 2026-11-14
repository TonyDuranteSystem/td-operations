import { notFound } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { isBookingStaff } from "@/lib/auth/booking-access"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { readBookingMode } from "@/lib/booking-links/switch"
import { loadOpenChecks } from "@/lib/booking/checks"
import { parseBookingTab } from "@/lib/leads/leads-url"
import { BookingTabs } from "@/components/booking/booking-tabs"
import { LinksAndCallsTab } from "@/components/booking/links-and-calls-tab"
import { LeadsWorkspace } from "@/components/leads/leads-workspace"

/**
 * Booking page (dev job 19d2654a, Stage 1b; opened to staff and given the Leads tab in dev job a1839d8b, 14 Nov 2026).
 * Two tabs, chosen by `?tab=`: "Leads" (the whole Leads page, moved in — it opens here by default, because Leads is the daily work) and "Links and calls" (the Calendly link maker,
 * "Links I made" and "Calls to check"). ANY STAFF login (an administrator or a team login) may open the page; everyone else gets the ordinary "page not found". The visitor is
 * checked FIRST, before any read.
 * The `booking` setting (off / page / live) only decides what the "Links and calls" tab can DO: while it is off that tab is read-only under a plain "Turned off" banner. The Leads
 * tab works exactly the same in every state. Only the chosen tab's data is loaded, so a failed read on one tab never takes down the other.
 * The day-to-day work Calendar is a different page and is not touched.
 * (Tags that follow a `}` are closed with an explicit closing tag, not `/>`: the standing access scan reads `/>` after a `}` as the start of a regex and would refuse to read the file.)
 */
export const dynamic = "force-dynamic"

export default async function BookingPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>
}) {
  const {
    data: { user },
  } = await createClient().auth.getUser()
  if (!isBookingStaff(user ?? null)) notFound()
  const tab = parseBookingTab(searchParams.tab)
  const mode = await readBookingMode(supabaseAdmin)

  const now = new Date()
  // read once: the count on the tab bar (so a waiting call is noticed from the Leads tab) and, on the Links and calls tab, the cards themselves. Never throws.
  const checks = await loadOpenChecks(supabaseAdmin, now)

  return (
    <div data-testid="booking-shell">
      <div className="px-6 pt-6 lg:px-8 lg:pt-8">
        <h1 className="text-2xl font-semibold tracking-tight">Booking</h1>
        <p className="mb-3 text-sm text-zinc-600">Leads, and a link for every kind of call.</p>
        <BookingTabs active={tab} callsCount={checks.ok ? checks.count : null} off={mode === "off"}></BookingTabs>
      </div>
      {tab === "leads" ? <LeadsWorkspace searchParams={searchParams}></LeadsWorkspace> : <LinksAndCallsTab mode={mode} checks={checks} now={now}></LinksAndCallsTab>}
    </div>
  )
}
