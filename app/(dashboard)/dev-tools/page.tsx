import { createClient } from '@/lib/supabase/server'
import { isAdmin } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { DevToolsPanel } from '@/components/dashboard/dev-tools-panel'
import { MaintenancePanel } from '@/components/dashboard/maintenance-panel'
import { EmailBackupPanel } from '@/components/dashboard/email-backup-panel'

export default async function DevToolsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!isAdmin(user)) {
    redirect('/')
  }

  return (
    <div className="p-6 lg:p-8 max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dev Tools</h1>
        <p className="text-muted-foreground text-sm mt-1">Create and clean test data for feature testing, plus operational maintenance triggers.</p>
      </div>
      <EmailBackupPanel />
      <DevToolsPanel />
      <MaintenancePanel />
    </div>
  )
}
