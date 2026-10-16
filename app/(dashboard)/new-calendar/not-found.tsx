import Link from 'next/link'
import { LiveRefresh } from '@/components/new-calendar/live-refresh'

/**
 * Calendar — "page not found" for this route. A person who is NOT allowed to open the Calendar sees an ordinary not-found page (the guard in
 * page.tsx calls notFound() first, before anything is loaded). But the guard also answers "no" when the setting or the sign-in check could not
 * be read for a moment, and a Calendar left open all day refreshes itself every minute: without this screen that one hiccup would replace the
 * page with a permanent 404. So this screen keeps the page's own retry, and always shows the way to the existing Calendar (renewals, Mark Filed).
 */
export default function CalendarNotFound() {
  return (
    <div className="p-6 lg:p-8">
      <LiveRefresh />
      <h1 className="text-2xl font-semibold tracking-tight">Calendar</h1>
      <div className="mt-4 rounded-lg border bg-zinc-50 p-4 text-sm text-zinc-700" role="status">
        <p className="font-medium">This page is not available right now.</p>
        <p className="mt-1">If you should have access, it will come back by itself in a minute.</p>
        <p className="mt-2">
          <Link href="/calendar" prefetch={false} className="text-blue-700 underline">Renewals and annual reports (Mark Filed)</Link> are on the existing Calendar.
        </p>
      </div>
    </div>
  )
}
