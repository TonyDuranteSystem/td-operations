import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { StaffFinancials } from './staff-financials'

export const dynamic = 'force-dynamic'

/**
 * /tools/pnl (staff) — the standalone entry to the MMLLC tax-financials system.
 * Staff pick any client + year and drive the SAME review the client uses in the
 * portal (upload → ingest+save → categorize → gates → P&L/Balance Sheet →
 * Excel), in staff mode. Reuses the existing engine + routes; no client needed.
 */
export default async function PnlToolPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) redirect('/')

  const currentYear = new Date().getFullYear()

  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">P&amp;L / Balance Sheet</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Run the tax-financials review for any client — upload their bank statements and prior-year
          return, review, and download the Profit &amp; Loss statement and Balance Sheet.
        </p>
      </div>
      <StaffFinancials defaultYear={currentYear - 1} />
    </div>
  )
}
