import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { redirect } from 'next/navigation'

// Retired (dev job ef5da377) — Finance (/finance) replaced this page. Every capability
// that was ever exclusive here has a home there now (see docs/systems/billing-invoicing.md's
// changelog), except creating a brand-new placeholder payment from scratch, which real usage
// showed had gone unused for months before this redirect shipped. Kept as a thin redirect
// rather than deleted outright so an old bookmark or muscle memory still lands somewhere
// correct instead of a dead end.
export default async function PaymentsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) redirect('/login')

  redirect('/finance')
}
