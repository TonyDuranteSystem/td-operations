import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isAdmin } from '@/lib/auth'
import { resolveCommParticipant, listConversationsForStaff } from '@/lib/td-communication/queries'
import { listEnrollments } from '@/lib/td-communication/pipeline-queries'
import { CrmCommunicationDashboard } from '@/components/td-communication/crm-communication-dashboard'
import type { CommEnrollment } from '@/lib/td-communication/types'

export const dynamic = 'force-dynamic'

/**
 * CRM staff view for TD Communication (/dashboard/td-communication). The
 * (dashboard) layout already auth-gates to dashboard users; this page resolves
 * the staff participant and loads the project pipeline, conversation list and
 * partner options for the tabbed dashboard (Projects / Deliverables / Chat) —
 * the staff equivalent of the partner /collab studio, reusing the same
 * components.
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

  let initialProjects: CommEnrollment[] = []
  try {
    initialProjects = await listEnrollments()
  } catch {
    initialProjects = []
  }

  const partners = (partnersRes.data ?? []).map((p) => ({
    id: p.id as string,
    partner_name: (p.partner_name as string | null) ?? null,
  }))

  return (
    <CrmCommunicationDashboard
      viewer={participant}
      initialProjects={initialProjects}
      conversations={conversations}
      partners={partners}
      isAdmin={isAdmin(user)}
    />
  )
}
