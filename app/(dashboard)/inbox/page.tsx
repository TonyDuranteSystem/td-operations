import { InboxShell } from '@/components/inbox/inbox-shell'
import { createClient } from '@/lib/supabase/server'
import { isAdmin } from '@/lib/auth'
import { inboxChannelFromParams } from '@/lib/nav/nav-active'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Inbox — TD Operations',
}

export default async function InboxPage({ searchParams }: { searchParams?: Record<string, string | string[] | undefined> }) {
  // antonio@ is Antonio's personal mailbox — admin only. The API routes
  // enforce this server-side (lib/inbox/mailbox-access.ts); this flag just
  // hides the toggle for team users.
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  // Email and WhatsApp are two menu pages on this one screen (Antonio 2026-11-04): the address says which one is open
  // (?channel=whatsapp, or an open chat ?thread=whatsapp:…). The shell shows that ONE channel; the key remounts it when the menu
  // switches between the two so it never keeps the other one's list, filters or open conversation.
  const thread = typeof searchParams?.thread === 'string' ? searchParams.thread : null
  const channelParam = typeof searchParams?.channel === 'string' ? searchParams.channel : null
  const channel = inboxChannelFromParams(thread, channelParam)
  // The dashboard <main> is a scroll container that stacks the sticky 56px
  // desktop header (`DashboardHeader`, h-14, lg-only) above the page. A plain
  // h-full inbox therefore overflows <main> by 56px on desktop → the whole page
  // scrolls. Subtract the header on lg (relative to <main>, so the sandbox
  // banner offset is respected) and keep the mobile content-box h-full (header
  // is hidden there). overflow-hidden makes the inbox's own panes the only
  // scrollers. Mirrors the app-shell pattern used by /portal-chats.
  return (
    <div className="h-full lg:h-[calc(100%_-_3.5rem)] overflow-hidden">
      <InboxShell key={channel} channel={channel} canUsePersonalMailbox={isAdmin(user)} userId={user?.id} />
    </div>
  )
}
