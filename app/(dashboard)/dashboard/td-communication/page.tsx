import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { resolveCommParticipant, listConversationsForStaff } from '@/lib/td-communication/queries'
import { TdCommunicationClient } from '@/components/td-communication/td-communication-client'

export const dynamic = 'force-dynamic'

/**
 * CRM staff view for TD Communication (/dashboard/td-communication). The
 * (dashboard) layout already auth-gates to dashboard users; this page resolves
 * the staff participant and loads the conversation list + partner options.
 */
export default async function TdCommunicationPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const participant = await resolveCommParticipant(user)
  if (!participant || participant.type !== 'staff') {
    redirect('/')
  }

  const [conversations, partnersRes] = await Promise.all([
    listConversationsForStaff(),
    supabaseAdmin
      .from('client_partners')
      .select('id, partner_name')
      .order('partner_name'),
  ])

  const partners = (partnersRes.data ?? []).map((p) => ({
    id: p.id as string,
    partner_name: (p.partner_name as string | null) ?? null,
  }))

  return (
    <TdCommunicationClient
      viewer={participant}
      initialConversations={conversations}
      partners={partners}
    />
  )
}
