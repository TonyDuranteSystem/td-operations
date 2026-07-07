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
  return <InboxShell canUsePersonalMailbox={isAdmin(user)} />
}
