import { Suspense } from 'react'
import { createClient } from '@/lib/supabase/server'
import { isAdmin } from '@/lib/auth'
import { CardSkeleton } from '@/components/dashboard/card-skeleton'
import { CardErrorBoundary } from '@/components/dashboard/card-error-boundary'
import { UrgentTasksCard } from '@/components/dashboard/cards/urgent-tasks'
import { UnreadMessagesCard } from '@/components/dashboard/cards/unread-messages'
import { UpcomingDeadlinesCard } from '@/components/dashboard/cards/upcoming-deadlines'
import { PendingFormsCard } from '@/components/dashboard/cards/pending-forms'
import { RecentPaymentsCard } from '@/components/dashboard/cards/recent-payments'
import { PendingActions } from '@/components/dashboard/pending-actions'
import { DevToolsPanel } from '@/components/dashboard/dev-tools-panel'

export default async function DashboardPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const admin = isAdmin(user)
  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground text-sm mt-1">Daily operations overview</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Row 1: Urgent Tasks (wide) + AI Pending Actions */}
        <div className="lg:col-span-2">
          <CardErrorBoundary fallbackTitle="Urgent Tasks">
            <Suspense fallback={<CardSkeleton title="Urgent Tasks" />}>
              <UrgentTasksCard />
            </Suspense>
          </CardErrorBoundary>
        </div>

        <PendingActions />

        {/* Row 2: Unread Messages + Deadlines + Pending Forms */}
        <CardErrorBoundary fallbackTitle="Unread Messages">
          <Suspense fallback={<CardSkeleton title="Unread Messages" />}>
            <UnreadMessagesCard />
          </Suspense>
        </CardErrorBoundary>

        <CardErrorBoundary fallbackTitle="Upcoming Deadlines">
          <Suspense fallback={<CardSkeleton title="Upcoming Deadlines" />}>
            <UpcomingDeadlinesCard />
          </Suspense>
        </CardErrorBoundary>

        <CardErrorBoundary fallbackTitle="Pending Forms">
          <Suspense fallback={<CardSkeleton title="Pending Forms" />}>
            <PendingFormsCard />
          </Suspense>
        </CardErrorBoundary>

        {/* Row 3: Recent Payments (admin only — financial data) */}
        {admin && (
          <CardErrorBoundary fallbackTitle="Recent Payments">
            <Suspense fallback={<CardSkeleton title="Recent Payments" />}>
              <RecentPaymentsCard />
            </Suspense>
          </CardErrorBoundary>
        )}

        {/* Dev Tools (admin only) */}
        {admin && <DevToolsPanel />}
      </div>
    </div>
  )
}
