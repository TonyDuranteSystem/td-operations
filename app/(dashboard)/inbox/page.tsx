import { InboxShell } from '@/components/inbox/inbox-shell'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Inbox — TD Operations',
}

export default async function InboxPage() {
  return <InboxShell />
}
