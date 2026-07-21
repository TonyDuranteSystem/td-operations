import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export const dynamic = 'force-dynamic'

/**
 * POST /api/inbox/create-from-email
 * Creates a task or service delivery from an email conversation.
 * Also links the Gmail thread to the account via email_links table.
 */
export async function POST(req: NextRequest) {
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

      // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw tasks.insert; no generic createTask helper exists yet (lib/operations/task.ts only covers workflow tasks + updates). Deferred per dev_task fda76fd3.
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

      // Route through createSD (2026-07-20) instead of a raw insert. The raw
      // insert bypassed every architectural rule the operations layer enforces:
      // it stamped a literal stage 'New' (not a real pipeline stage) and left
      // contact_id NULL — so an ITIN created here was account-scoped, contrary
      // to the Phase 1 contact-scoped rule, and therefore INVISIBLE to the
      // per-person ITIN duplicate guard and to uq_itin_sd_active_per_contact.
      // createSD resolves the real first stage and the contact from the account.
      const { createSD } = await import('@/lib/operations/service-delivery')
      let sd: { id: string; service_name: string }
      try {
        const created = await createSD({
          service_type: serviceType,
          service_name: serviceName,
          account_id: accountId,
          notes: notes ? `${notes}${threadId ? ` | Gmail thread: ${threadId}` : ''}` : (threadId ? `Gmail thread: ${threadId}` : null),
        })
        sd = { id: created.id, service_name: created.service_name }
      } catch (e) {
        // Surface the real reason (R099) — e.g. the DB backstop reporting that
        // this person already has a live ITIN, or an account with no linked
        // contact for a service that requires one.
        const msg = e instanceof Error ? e.message : String(e)
        let friendly = msg
        if (msg.includes('23505') || /duplicate key value/i.test(msg)) {
          friendly = `This client already has an active ${serviceType} service — open it instead of creating a second one.`
        } else if (/No pipeline_stages defined/i.test(msg)) {
          // Not every sellable service has a delivery pipeline configured yet
          // (Public Notary / Shipping / Support have none). The old raw insert
          // hid this by stamping a fake stage; say it plainly instead of
          // leaking the internal error text to staff.
          friendly = `"${serviceType}" has no delivery pipeline set up yet, so a service can't be created for it here. Ask for its stages to be configured first, or track this by creating a task instead.`
        } else if (/requires contact_id|has no linked contacts/i.test(msg)) {
          friendly = `${serviceType} is a personal service and needs a contact. Link a contact to this client account first, then try again.`
        }
        return NextResponse.json({ error: friendly }, { status: 400 })
      }

      // NOTE: no task insert here. createSD already creates one — the workflow
      // task when the service type has a workflow, otherwise its universal
      // tracked-task fallback. The raw insert this route used to do ran BEFORE
      // it went through createSD, so keeping it would give Luca two
      // near-identical tasks for every service created from an email.

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
