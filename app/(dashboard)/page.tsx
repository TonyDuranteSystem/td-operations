import { Suspense } from 'react'
import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { CardSkeleton } from '@/components/dashboard/card-skeleton'
import { CardErrorBoundary } from '@/components/dashboard/card-error-boundary'
import { NeedsAttentionCard } from '@/components/dashboard/cards/needs-attention'
import { EmailIntelligenceCard } from '@/components/dashboard/cards/email-intelligence'
import { TodayEventsCard } from '@/components/dashboard/cards/today-events'
import { RecentActivityCard } from '@/components/dashboard/cards/recent-activity'
import { UnreadMessagesCard } from '@/components/dashboard/cards/unread-messages'
import { UpcomingDeadlinesCard } from '@/components/dashboard/cards/upcoming-deadlines'
import { PendingFormsCard } from '@/components/dashboard/cards/pending-forms'
import { RecentPaymentsCard } from '@/components/dashboard/cards/recent-payments'
import { DevToolsPanel } from '@/components/dashboard/dev-tools-panel'
import { OperationsPipelineCard } from '@/components/dashboard/cards/operations-pipeline'
import { ActiveOnboardingsCard } from '@/components/dashboard/cards/active-onboardings'
import { RevenuePipelineCard } from '@/components/dashboard/cards/revenue-pipeline'

export default async function DashboardPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const admin = isDashboardUser(user)
  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground text-sm mt-1">Live operations overview</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Row 0: Operations Pipeline (full width) */}
        <div className="lg:col-span-3">
          <CardErrorBoundary fallbackTitle="Operations Pipeline">
            <OperationsPipelineCard />
          </CardErrorBoundary>
        </div>

        {/* Row 0b: Active Onboardings (wide) + Revenue Pipeline */}
        <div className="lg:col-span-2">
          <CardErrorBoundary fallbackTitle="Active Onboardings">
            <ActiveOnboardingsCard />
          </CardErrorBoundary>
        </div>

        <CardErrorBoundary fallbackTitle="Revenue Pipeline">
          <RevenuePipelineCard />
        </CardErrorBoundary>

        {/* Row 1: Email Assistant (wide) + Today */}
        <div className="lg:col-span-2">
          <CardErrorBoundary fallbackTitle="Email Assistant">
            <EmailIntelligenceCard />
          </CardErrorBoundary>
        </div>

        <CardErrorBoundary fallbackTitle="Today">
          <Suspense fallback={<CardSkeleton title="Today" />}>
            <TodayEventsCard />
          </Suspense>
        </CardErrorBoundary>

        {/* Row 2: Needs Attention (wide) + Unread Messages */}
        <div className="lg:col-span-2">
          <CardErrorBoundary fallbackTitle="Needs Attention">
            <NeedsAttentionCard />
          </CardErrorBoundary>
        </div>

        <CardErrorBoundary fallbackTitle="Unread Messages">
          <Suspense fallback={<CardSkeleton title="Unread Messages" />}>
            <UnreadMessagesCard />
          </Suspense>
        </CardErrorBoundary>

        {/* Row 3: Recent Activity (wide) + Pending Forms */}
        <div className="lg:col-span-2">
          <CardErrorBoundary fallbackTitle="Recent Activity">
            <Suspense fallback={<CardSkeleton title="Recent Activity" />}>
              <RecentActivityCard />
            </Suspense>
          </CardErrorBoundary>
        </div>

        <CardErrorBoundary fallbackTitle="Pending Forms">
          <Suspense fallback={<CardSkeleton title="Pending Forms" />}>
            <PendingFormsCard />
          </Suspense>
        </CardErrorBoundary>

        {/* Row 4: Deadlines + Payments (admin) */}
        <CardErrorBoundary fallbackTitle="Upcoming Deadlines">
          <Suspense fallback={<CardSkeleton title="Upcoming Deadlines" />}>
            <UpcomingDeadlinesCard />
          </Suspense>
        </CardErrorBoundary>

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
