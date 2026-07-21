import { NotesBoard } from '@/components/dashboard/notes-board'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Notes — TD Operations' }

/**
 * Notes page — every post-it visible to me, in one place: what's on screen now, what's
 * snoozed (and when it comes back), and what I've cleared. The floating layer only ever
 * shows the active ones, so this is where a snoozed or done note is found again.
 * Staff-only by the dashboard layout's auth gate; the feed itself re-checks.
 */
export default function NotesPage() {
  return (
    <div className="p-4 lg:p-6">
      <h1 className="mb-1 text-xl font-semibold">Notes</h1>
      <p className="mb-4 text-sm text-zinc-500">
        Your post-its — active, snoozed, and done. Notes others shared with you appear here too.
      </p>
      <NotesBoard />
    </div>
  )
}
