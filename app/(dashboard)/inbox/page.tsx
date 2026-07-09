import { InboxShell } from '@/components/inbox/inbox-shell'
import { createClient } from '@/lib/supabase/server'
import { isAdmin } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Inbox — TD Operations',
}

export default async function InboxPage() {
  // antonio@ is Antonio's personal mailbox — admin only. The API routes
  // enforce this server-side (lib/inbox/mailbox-access.ts); this flag just
  // hides the toggle for team users.
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  // The dashboard <main> is a scroll container that stacks the sticky 56px
  // desktop header (`DashboardHeader`, h-14, lg-only) above the page. A plain
  // h-full inbox therefore overflows <main> by 56px on desktop → the whole page
  // scrolls. Subtract the header on lg (relative to <main>, so the sandbox
  // banner offset is respected) and keep the mobile content-box h-full (header
  // is hidden there). overflow-hidden makes the inbox's own panes the only
  // scrollers. Mirrors the app-shell pattern used by /portal-chats.
  return (
    <div className="h-full lg:h-[calc(100%_-_3.5rem)] overflow-hidden">
      <InboxShell canUsePersonalMailbox={isAdmin(user)} />
    </div>
  )
}
