import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { redirect } from 'next/navigation'

// Retired (dev job ef5da377) — Finance (/finance) replaced this page. Every capability
// that was ever exclusive here has a home there now (see docs/systems/billing-invoicing.md's
// changelog), except creating a brand-new placeholder payment from scratch, which real usage
// showed had gone unused for months before this redirect shipped. Kept as a thin redirect
// rather than deleted outright so an old bookmark or muscle memory lands on Finance's
// default view instead of a dead end — this does NOT preserve any ?tab= a bookmark carried,
// since the old page's tab vocabulary doesn't map onto Finance's (senior-engineer review,
// same job). The old page's own server actions (actions.ts, invoice-actions.ts) are
// neutered, not just unlinked — a Server Action stays independently callable by reference
// regardless of whether a page still renders a trigger for it, so the redirect alone
// doesn't retire them.
export default async function PaymentsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) redirect('/login')

  redirect('/finance')
}
