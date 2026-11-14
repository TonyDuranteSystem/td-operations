import { notFound } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { readBookingMode } from "@/lib/booking-links/switch"
import { listKinds, type KindDto } from "@/lib/booking/kinds-admin"
import { listLinks, type LinkDto } from "@/lib/booking/links"
import { loadTemplates } from "@/lib/booking/templates"
import { loadOpenChecks } from "@/lib/booking/checks"
import { BookingWorkspace } from "@/components/booking/booking-workspace"

/**
 * Booking page (dev job 19d2654a, Stage 1b) — ADMIN ONLY. One place where Antonio makes a Calendly link for a chosen person and kind, and sees the links he made.
 * The visitor is checked FIRST, before any read: a non-admin gets the ordinary "page not found", exactly like a page that does not exist.
 * The page also needs the `booking` setting to be `page` or `live` (missing = off = not found), so it ships hidden and Claude turns it on when Antonio says.
 * "Calls to check" (the bookings the system could not settle by itself) are a section of THIS page — the day-to-day work Calendar is a different page and is not touched.
 * Reads that fail say so on the page; they are never shown as an empty list.
 */
export const dynamic = "force-dynamic"

export default async function BookingPage() {
  const {
    data: { user },
  } = await createClient().auth.getUser()
  if (!isSecureAdmin(user ?? null)) notFound()
  if ((await readBookingMode(supabaseAdmin)) === "off") notFound()

  const now = new Date()
  const [kinds, links, templates, checks] = await Promise.all([
    listKinds(supabaseAdmin),
    listLinks(supabaseAdmin, now),
    loadTemplates(supabaseAdmin),
    loadOpenChecks(supabaseAdmin, now),
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
        callTypesReady={!!templates.plain && !!templates.sales}
        cards={"cards" in checks ? checks.cards : null}
      >
      </BookingWorkspace>
    </div>
  )
}
