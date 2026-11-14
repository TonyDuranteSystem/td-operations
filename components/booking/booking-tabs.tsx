import Link from "next/link"
import { cn } from "@/lib/utils"
import { leadsListHref, linksTabHref, type BookingTab } from "@/lib/leads/leads-url"

/**
 * The two tabs of the Booking page (dev job a1839d8b): "Leads" (the whole Leads page, moved in) and "Links and calls" (the Calendly link maker, "Links I made" and "Calls to check").
 * Plain links, so a tab is an ordinary address: it can be bookmarked, opened in a window, and Back works. A server component — no script. The "Links and calls" tab carries the red count of
 * calls waiting for a look (so it is noticed from the Leads tab), and a small "Off" mark while the link side is turned off; the Leads tab never carries an "Off" mark: Leads works either way.
 */
export function BookingTabs({ active, callsCount, off }: { active: BookingTab; callsCount: number | null; off: boolean }) {
  const base = "inline-flex items-center gap-2 rounded-t-lg border-b-2 px-4 py-2 text-sm font-medium transition-colors"
  const on = "border-zinc-900 text-zinc-900"
  const idle = "border-transparent text-zinc-500 hover:text-zinc-800"
  return (
    <nav aria-label="Booking sections" className="flex gap-1 border-b" data-testid="booking-tabs">
      <Link href={leadsListHref()} className={cn(base, active === "leads" ? on : idle)} aria-current={active === "leads" ? "page" : undefined} data-testid="tab-leads">
        Leads
      </Link>
      <Link href={linksTabHref()} className={cn(base, active === "links" ? on : idle)} aria-current={active === "links" ? "page" : undefined} data-testid="tab-links">
        Links and calls
        {callsCount !== null && callsCount > 0 && (
          <span className="rounded-full bg-red-100 px-2 py-0.5 font-mono text-xs text-red-700" data-testid="tab-calls-count">{callsCount}</span>
        )}
        {off && <span className="rounded-full bg-amber-200 px-2 py-0.5 text-xs font-semibold text-amber-900" data-testid="off-tag">Off</span>}
      </Link>
    </nav>
  )
}
