import { Suspense } from 'react'
import { CardSkeleton } from '@/components/dashboard/card-skeleton'
import { CardErrorBoundary } from '@/components/dashboard/card-error-boundary'
import { UrgentTasksCard } from '@/components/dashboard/cards/urgent-tasks'
import { UnreadMessagesCard } from '@/components/dashboard/cards/unread-messages'
import { UpcomingDeadlinesCard } from '@/components/dashboard/cards/upcoming-deadlines'
import { PendingFormsCard } from '@/components/dashboard/cards/pending-forms'
import { RecentPaymentsCard } from '@/components/dashboard/cards/recent-payments'

export default function DashboardPage() {
  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground text-sm mt-1">Daily operations overview</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Row 1: Urgent Tasks (wide) + Unread Messages */}
        <div className="lg:col-span-2">
          <CardErrorBoundary fallbackTitle="Urgent Tasks">
            <Suspense fallback={<CardSkeleton title="Urgent Tasks" />}>
              <UrgentTasksCard />
            </Suspense>
          </CardErrorBoundary>
        </div>

        <CardErrorBoundary fallbackTitle="Unread Messages">
          <Suspense fallback={<CardSkeleton title="Unread Messages" />}>
            <UnreadMessagesCard />
          </Suspense>
        </CardErrorBoundary>

        {/* Row 2: Deadlines + Pending Forms + Recent Payments */}
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

        <CardErrorBoundary fallbackTitle="Recent Payments">
          <Suspense fallback={<CardSkeleton title="Recent Payments" />}>
            <RecentPaymentsCard />
          </Suspense>
        </CardErrorBoundary>
      </div>
    </div>
  )
}
