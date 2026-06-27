import { redirect } from 'next/navigation'
import { MessagesSquare } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { getCommPartner } from '@/lib/partner-auth'
import {
  listConversationsForPartner,
  createConversation,
} from '@/lib/td-communication/queries'
import { ConversationChat } from '@/components/td-communication/conversation-chat'
import type { CommParticipant } from '@/lib/td-communication/types'

export const dynamic = 'force-dynamic'

/**
 * Standalone partner view for TD Communication (/collab). Gated by
 * role='partner' + client_partners.partner_scope containing 'td_communication'
 * (getCommPartner). Middleware confines role='partner' users to /collab +
 * /api/conversations; this page does the per-partner authorization.
 *
 * The partner gets a single ongoing channel with TD — get-or-create here.
 */
export default async function PartnerCommunicationPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')

  const partner = await getCommPartner(user)
  if (!partner) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50 p-6">
        <div className="max-w-md text-center">
          <MessagesSquare className="h-10 w-10 text-zinc-300 mx-auto mb-3" />
          <h1 className="text-lg font-semibold text-zinc-900 mb-1">No access</h1>
          <p className="text-sm text-zinc-500">
            This area is reserved for TD communication partners. If you believe this is an error,
            contact support@tonydurante.us.
          </p>
        </div>
      </div>
    )
  }

  const viewer: CommParticipant = {
    type: 'partner',
    id: partner.id,
    name: partner.partner_name ?? 'Partner',
  }

  // Get-or-create the partner's channel.
  const existing = await listConversationsForPartner(partner.id)
  const conversation = existing[0] ?? (await createConversation({ creator: viewer }))

  return (
    <div className="min-h-screen flex flex-col bg-zinc-50">
      <header className="shrink-0 bg-white border-b px-4 py-3 flex items-center gap-2">
        <MessagesSquare className="h-5 w-5 text-blue-600" />
        <div>
          <h1 className="text-base font-bold leading-tight">TD Communication</h1>
          <p className="text-[11px] text-zinc-500 leading-tight">{partner.partner_name ?? 'Partner'}</p>
        </div>
      </header>
      <main className="flex-1 min-h-0 flex flex-col p-4 max-w-3xl w-full mx-auto">
        <ConversationChat conversationId={conversation.id} viewer={viewer} />
      </main>
    </div>
  )
}
