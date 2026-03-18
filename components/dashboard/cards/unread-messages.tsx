import { MessageSquare, Inbox } from 'lucide-react'
import Link from 'next/link'

async function fetchInboxStats() {
  try {
    // Use internal fetch to the inbox stats API
    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'http://localhost:3000'
    const res = await fetch(`${baseUrl}/api/inbox/stats`, {
      cache: 'no-store',
    })
    if (res.ok) {
      return await res.json()
    }
  } catch {
    // Silently fail — card shows "All caught up" on error
  }
  return null
}

export async function UnreadMessagesCard() {
  const stats = await fetchInboxStats()

  const totalUnread = stats?.unread ?? 0

  if (totalUnread === 0) {
    return (
      <div className="bg-white rounded-lg border p-5">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
          Unread Messages
        </h3>
        <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
          <Inbox className="h-8 w-8 mb-2 text-blue-400" />
          <p className="text-sm">All caught up</p>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-lg border p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Unread Messages
        </h3>
        <Link href="/inbox" className="text-xs text-blue-600 hover:underline">
          Open inbox
        </Link>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex items-center justify-center h-12 w-12 rounded-full bg-blue-50">
          <MessageSquare className="h-6 w-6 text-blue-600" />
        </div>
        <div>
          <p className="text-2xl font-semibold">{totalUnread}</p>
          <p className="text-xs text-muted-foreground">unread messages</p>
        </div>
      </div>
    </div>
  )
}
