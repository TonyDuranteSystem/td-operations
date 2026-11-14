import { supabaseAdmin } from "@/lib/supabase-admin"
import type { BookingMode } from "@/lib/booking-links/switch"
import { listKinds, type KindDto } from "@/lib/booking/kinds-admin"
import { listLinks, type LinkDto } from "@/lib/booking/links"
import { loadTemplates } from "@/lib/booking/templates"
import type { LoadChecks } from "@/lib/booking/checks"
import { BookingWorkspace } from "@/components/booking/booking-workspace"

/**
 * The "Links and calls" tab of the Booking page (server component). Loads ONLY this tab's data — the Leads tab never waits for it and a failed read here never touches the Leads list.
 * Called by the Booking page AFTER its staff check has passed; it checks nobody itself (only that page imports it, and a test pins that).
 * The waiting-calls cards are read once by the page (for the red count on the tab) and handed in, so the tab does not read them twice.
 * Reads that fail say so on the page; they are never shown as an empty list.
 */
export async function LinksAndCallsTab({ mode, checks, now }: { mode: BookingMode; checks: LoadChecks; now: Date }) {
  const [kinds, links, templates] = await Promise.all([
    listKinds(supabaseAdmin),
    listLinks(supabaseAdmin, now),
    loadTemplates(supabaseAdmin),
  ])
  const dateText = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long", day: "numeric", month: "long" }).format(now)

  return (
    <div className="p-6 lg:p-8">
      <BookingWorkspace
        dateText={dateText}
        kinds={"kinds" in kinds ? (kinds.kinds as KindDto[]) : null}
        kindsError={"error" in kinds ? kinds.error : null}
        links={"links" in links ? (links.links as LinkDto[]) : null}
        linksError={"error" in links ? links.error : null}
        mode={mode}
        callTypesReady={!!templates.plain && !!templates.sales}
        cards={"cards" in checks ? checks.cards : null}
      >
      </BookingWorkspace>
    </div>
  )
}
