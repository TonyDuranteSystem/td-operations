import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { requireStaffRoute } from "@/lib/auth/require-staff-route"

export const dynamic = 'force-dynamic'

/**
 * POST /api/inbox/create-from-email
 * Creates a task or service delivery from an email conversation.
 * Also links the Gmail thread to the account via email_links table.
 */
export async function POST(req: NextRequest) {
  // Staff gate — middleware only guarantees "is logged in" for /api routes,
  // and a portal CLIENT has a login (2026-07-21 invariant; council find 2026-07-29,
  // dev job 7e63fcd2).
  const denied = await requireStaffRoute()
  if (denied) return denied

  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const { type, accountId, threadId } = body

  try {
    if (type === 'task') {
      const { title, description, priority, category, assignedTo } = body

      if (!title?.trim()) {
        return NextResponse.json({ error: 'Title is required' }, { status: 400 })
      }

      // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw write on this legacy route; untouched by the ITIN split. Hardening lives on claude/inbox-create-service-hardening. Deferred per dev_task fda76fd3.
      const { data: task, error } = await supabaseAdmin
        .from('tasks')
        .insert({
          task_title: title.trim(),
          description: description?.trim() || null,
          priority: priority || 'Normal',
          category: category || null,
          assigned_to: assignedTo || 'Luca',
          status: 'To Do',
          account_id: accountId || null,
        })
        .select('id, task_title')
        .single()

      if (error) throw new Error(error.message)

      // Link thread to account if both exist
      if (threadId && accountId) {
        await supabaseAdmin
          .from('email_links')
          .upsert({ thread_id: threadId, account_id: accountId, linked_by: 'create_task' }, { onConflict: 'thread_id' })
      }

      return NextResponse.json({ success: true, taskId: task.id, title: task.task_title })

    } else if (type === 'service') {
      const { serviceType, notes } = body

      if (!serviceType) {
        return NextResponse.json({ error: 'Service type is required' }, { status: 400 })
      }
      if (!accountId) {
        return NextResponse.json({ error: 'Account is required for services' }, { status: 400 })
      }

      // Get account name for service name
      const { data: account } = await supabaseAdmin
        .from('accounts')
        .select('company_name')
        .eq('id', accountId)
        .single()

      const serviceName = `${serviceType} — ${account?.company_name || 'Unknown'}`
      const sdNotes = notes
        ? `${notes}${threadId ? ` | Gmail thread: ${threadId}` : ''}`
        : (threadId ? `Gmail thread: ${threadId}` : null)

      // TWO SHAPES OF SERVICE, and this route must respect both.
      //
      // Most service types run through a tracked pipeline. A few — Shipping,
      // Public Notary, Support — are deliberately one-off billables with NO
      // pipeline at all (see createBackfilledSD, which names them). Both are
      // legitimate, so this route asks the database which shape it is dealing
      // with rather than carrying its own list that would rot the day a
      // pipeline is added.
      const { data: stageRows } = await supabaseAdmin
        .from('pipeline_stages')
        .select('service_type')
        .eq('service_type', serviceType)
        .limit(1)
      const hasPipeline = (stageRows?.length ?? 0) > 0

      let sd: { id: string; service_name: string | null }

      if (hasPipeline) {
        // Route through the operations layer. The raw insert this replaces
        // stamped a literal stage 'New' — not a real pipeline stage — and left
        // contact_id NULL. For ITIN that broke the contact-scoped rule, so a
        // service created here was invisible BOTH to the one-ITIN-per-person
        // guard and to the database index enforcing it: this door could still
        // mint the duplicate ITIN the rest of the system now prevents.
        const { createSD } = await import('@/lib/operations/service-delivery')
        try {
          const created = await createSD({
            service_type: serviceType,
            service_name: serviceName,
            account_id: accountId,
            notes: sdNotes ?? undefined,
          })
          sd = { id: created.id, service_name: created.service_name }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          const friendly =
            msg.includes('23505') || /duplicate key value/i.test(msg)
              ? `This client already has an active ${serviceType} service — open that one instead of creating a second.`
              : /requires contact_id|has no linked contacts/i.test(msg)
                ? `${serviceType} is a personal service and needs a contact. Link a contact to this client first, then try again.`
                : msg
          return NextResponse.json({ error: friendly }, { status: 400 })
        }
        // NOTE: no task insert here. createSD already creates one (a workflow
        // task, or its universal fallback). Adding another would give staff two
        // near-identical tasks for every service created from an email.
      } else {
        // No pipeline: a genuine one-off billable. Kept exactly as it was —
        // this shape is supported and staff rely on it.
        // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw write; no-pipeline services have no operations-layer helper for an OPEN request (createBackfilledSD inserts status='completed'). Deferred per dev_task fda76fd3.
        const { data: rawSd, error } = await supabaseAdmin
          .from('service_deliveries')
          .insert({
            account_id: accountId,
            service_type: serviceType,
            service_name: serviceName,
            pipeline: serviceType,
            stage: 'New',
            stage_order: 0,
            stage_entered_at: new Date().toISOString(),
            status: 'active',
            assigned_to: 'Luca',
            notes: sdNotes,
          })
          .select('id, service_name')
          .single()

        if (error) throw new Error(error.message)
        sd = rawSd

        // Only the no-pipeline path needs its own task — createSD makes one on
        // the other branch.
        // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw tasks.insert; deferred per dev_task fda76fd3.
        await supabaseAdmin
          .from('tasks')
          .insert({
            task_title: serviceName,
            description: notes || `New ${serviceType} service created from email`,
            assigned_to: 'Luca',
            status: 'To Do',
            priority: 'Normal',
            account_id: accountId,
            delivery_id: sd.id,
          })
      }

      // Link thread to account
      if (threadId) {
        await supabaseAdmin
          .from('email_links')
          .upsert({
            thread_id: threadId,
            account_id: accountId,
            service_delivery_id: sd.id,
            linked_by: 'create_service',
          }, { onConflict: 'thread_id' })
      }

      return NextResponse.json({ success: true, deliveryId: sd.id, serviceName: sd.service_name })

    } else {
      return NextResponse.json({ error: `Unknown type: ${type}` }, { status: 400 })
    }
  } catch (err) {
    console.error('[create-from-email] Error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
