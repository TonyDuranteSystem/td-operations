import * as Sentry from '@sentry/nextjs'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireOpenServicesAccess } from '@/lib/open-services/audience'
import { loadNewCalendarInputs } from '@/lib/new-calendar/load'
import { buildNewCalendar } from '@/lib/new-calendar/build'
import { firstNameOf, greetingWord } from '@/lib/new-calendar/greeting'
import { parseParams, type RawSearchParams } from '@/lib/new-calendar/params'
import type { CalendarModel } from '@/lib/new-calendar/types'
import { NewCalendarView } from '@/components/new-calendar/new-calendar-view'

/**
 * New Calendar (dev job 40235e3c, child of be7da01a): the day-by-day work list the team opens every morning — what is on us,
 * what is waiting on someone else, what is finished. Built on the Open services data, so it uses the SAME switch
 * (`open_services_audience`: off | owners | all) and the same guard. READ-ONLY in this version.
 *
 * The guard runs FIRST and on EVERY request (this page is dynamic; nothing is cached). A denied visitor gets the ordinary
 * "page not found". A failed read shows "Could not load" — never an empty list that looks like all clear. `notFound()` is
 * called outside the try block on purpose (it works by throwing).
 */
export const dynamic = 'force-dynamic'

export default async function NewCalendarPage({ searchParams }: { searchParams: RawSearchParams }) {
  const access = await requireOpenServicesAccess()
  if (!access.ok) notFound()

  const params = parseParams(searchParams ?? {})
  const now = new Date()

  // The What's New tab does not use the Open services data: skip the (heavy) load there, so a failed Open services read
  // can never hide the news, and every refresh of the news tab stays cheap.
  const wantsJobs = params.tab !== 'news'
  let model: CalendarModel | null = null
  let failed = false
  try {
    if (wantsJobs) {
      const inputs = await loadNewCalendarInputs(access, now)
      model = buildNewCalendar({ ...inputs, now }, params)
    }
  } catch (err) {
    failed = true
    console.error('[new-calendar] load failed:', err)
    // Also report it: a page that quietly says "Could not load" must still be visible to us.
    Sentry.captureException(err, { tags: { area: 'new-calendar' } })
  }

  const name = firstNameOf(access.user)
  const greeting = name ? `${greetingWord(now)}, ${name}` : greetingWord(now)

  if (failed) {
    return (
      <div className="p-6 lg:p-8">
        <h1 className="text-2xl font-semibold tracking-tight">New Calendar</h1>
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert">
          <p className="font-medium">Could not load the New Calendar.</p>
          <p className="mt-1">Nothing was changed, and nothing is hidden or fixed by this page. Reload to try again.</p>
          <p className="mt-2"><Link href="/new-calendar?tab=news" prefetch={false} className="underline">What&apos;s New</Link> does not depend on this and can still be opened.</p>
        </div>
      </div>
    )
  }

  return <NewCalendarView model={model} params={params} greeting={greeting} />
}
