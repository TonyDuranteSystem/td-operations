import { redirect } from 'next/navigation'
import { leadsListHref } from '@/lib/leads/leads-url'

/**
 * The old Leads address (dev job a1839d8b, 14 Nov 2026). The Leads list now lives inside the Booking page as its "Leads" tab, so /leads — and every old link,
 * bookmark, email and notification that points here, with its query string (q, page, view, client, the filters) — lands on `/booking?tab=leads&…` with every
 * parameter kept. The page reads and shows nothing itself; whoever lands on the Booking page is checked there. The lead DETAIL page (/leads/<id>) is a separate
 * route and is not touched by this.
 */
export const dynamic = 'force-dynamic'

export default function LeadsPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>
}) {
  redirect(leadsListHref(searchParams))
}
