import { createClient } from '@/lib/supabase/server'
import { isAdmin } from '@/lib/auth'
import { InboxShell } from '@/components/inbox/inbox-shell'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Inbox — TD Operations',
}

export default async function InboxPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const admin = isAdmin(user)

  return <InboxShell isAdmin={admin} />
}
