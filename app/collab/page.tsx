import { redirect } from 'next/navigation'
import { MessagesSquare } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { getCommPartner } from '@/lib/partner-auth'
import {
  listConversationsForPartner,
  createConversation,
} from '@/lib/td-communication/queries'
import { listEnrollmentsForWorkerPartner } from '@/lib/td-communication/pipeline-queries'
import { logPartnerAccess } from '@/lib/td-communication/partner-access-log'
import { postOverdueAlerts } from '@/lib/td-communication/sla'
import { CollabDashboard } from '@/components/td-communication/collab-dashboard'
import type { CommEnrollment, CommParticipant } from '@/lib/td-communication/types'

export const dynamic = 'force-dynamic'

/**
 * Partner creative-studio dashboard (/collab). Gated by role='partner' +
 * client_partners.partner_scope containing 'td_communication' (getCommPartner).
 * Middleware confines role='partner' users to /collab + /api/conversations +
 * /api/td-communication; this page does the per-partner authorization.
 *
 * Phase 2 expands the old single-chat page into a dashboard: a read-only project
 * pipeline (hero), the existing realtime chat (now one section), and settings.
 * The partner still gets a single ongoing channel with TD — get-or-create here.
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

  // Cosmetic display identity: prefer the partner's display_title (e.g.
  // "Communication Expert") for the header + chat sender name, falling back to
  // the partner name. Role/scope are unaffected — this is presentation only.
  const displayName = partner.display_title ?? partner.partner_name ?? 'Partner'

  const viewer: CommParticipant = {
    type: 'partner',
    id: partner.id,
    name: displayName,
  }

  // Get-or-create the partner's channel, and load the pipeline for first paint.
  const existing = await listConversationsForPartner(partner.id)
  const conversation = existing[0] ?? (await createConversation({ creator: viewer }))

  let initialProjects: CommEnrollment[] = []
  try {
    // Scoped to THIS partner's assigned projects only (Antonio 2026-08-07,
    // reversing the earlier full-pipeline visibility): the pipeline holds
    // every client's subject data, which a partner has no business seeing.
    initialProjects = await listEnrollmentsForWorkerPartner(partner.id)
  } catch {
    initialProjects = []
  }
  logPartnerAccess({
    partnerId: partner.id,
    surface: 'collab_page',
    method: 'GET',
    path: '/collab',
    detail: { projects: initialProjects.length },
  })

  // Phase 10: post a one-time overdue notice in the chat for any project past
  // its deadline that hasn't been alerted yet (no cron — checked on render).
  await postOverdueAlerts(initialProjects)

  return (
    <CollabDashboard
      viewer={viewer}
      conversationId={conversation.id}
      initialProjects={initialProjects}
      partnerName={displayName}
    />
  )
}
