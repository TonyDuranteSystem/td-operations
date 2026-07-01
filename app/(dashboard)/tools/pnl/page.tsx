import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { PnlForm } from './pnl-form'

export const dynamic = 'force-dynamic'

export default async function PnlToolPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) redirect('/')

  const currentYear = new Date().getFullYear()

  return (
    <div className="p-6 lg:p-8 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Generate P&amp;L</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Build a Profit &amp; Loss statement and Balance Sheet — for an existing client from
          their processed bank data, or for any company from uploaded bank CSVs.
        </p>
      </div>
      <PnlForm defaultYear={currentYear - 1} />
    </div>
  )
}
