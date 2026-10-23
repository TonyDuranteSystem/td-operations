import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isStaffUser } from '@/lib/auth'
import { getClientAccountIds } from '@/lib/portal-auth'
import { multiMemberAccountIds } from '@/lib/portal/thread-scope'
import { parseBulkDeleteIds, planBulkDelete, type BulkDeleteRow, type BulkDeleteScope } from '@/lib/portal/bulk-delete-messages'

export const dynamic = 'force-dynamic'

/**
 * POST /api/portal/chat/messages/bulk-delete  { ids: string[], account_id | contact_id }  — Admin only.
 * Soft-delete several messages of ONE chat in one go (same effect as DELETE /api/portal/chat/message/[id] for each; R100): the rows
 * are kept with deleted_at / deleted_by, the client's reads filter them out (the Portal Chats screen hides them for staff too). The
 * request names the conversation that is open (account_id = a company's chat, or contact_id = one person's unified thread) and every
 * message must belong to it, at most 100; already-deleted ones are skipped and counted.
 * Answer: { ok, deleted, alreadyDeleted }
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isStaffUser(user)) {
    return NextResponse.json({ error: 'Staff access required' }, { status: 403 })
  }

  const body = await request.json().catch(() => ({}))
  const parsed = parseBulkDeleteIds((body as { ids?: unknown }).ids)
  if (parsed.ok === false) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const b = body as { account_id?: unknown; contact_id?: unknown }
  const accountId = typeof b.account_id === 'string' && b.account_id ? b.account_id : null
  const contactId = typeof b.contact_id === 'string' && b.contact_id ? b.contact_id : null
  if (!!accountId === !!contactId) {
    return NextResponse.json({ error: 'Name the open conversation: account_id or contact_id (exactly one)' }, { status: 400 })
  }
  // A person's thread on screen leaves out the chats of multi-member companies (they have their own thread), so a delete from that
  // thread may not reach them either — the same exclusion the thread read applies (app/api/portal/chat/route.ts).
  let scope: BulkDeleteScope
  if (accountId) {
    scope = { kind: 'account', accountId }
  } else {
    const linked = await getClientAccountIds(contactId as string)
    const multi = new Set(await multiMemberAccountIds(linked))
    scope = { kind: 'contact', contactId: contactId as string, linkedAccountIds: linked.filter((a) => !multi.has(a)) }
  }

  const { data: rows, error: readError } = await supabaseAdmin
    .from('portal_messages')
    .select('id, account_id, contact_id, deleted_at')
    .in('id', parsed.ids)
  if (readError) return NextResponse.json({ error: readError.message }, { status: 500 })

  const plan = planBulkDelete(parsed.ids, (rows ?? []) as BulkDeleteRow[], scope)
  if (plan.ok === false) return NextResponse.json({ error: plan.error }, { status: plan.status })
  if (plan.toDelete.length === 0) return NextResponse.json({ ok: true, deleted: 0, alreadyDeleted: plan.alreadyDeleted })

  // .is('deleted_at', null) again on the write: a message deleted by someone else since the read is not counted twice
  const { data: done, error: writeError } = await supabaseAdmin
    .from('portal_messages')
    .update({ deleted_at: new Date().toISOString(), deleted_by: user.id })
    .in('id', plan.toDelete)
    .is('deleted_at', null)
    .select('id')
  if (writeError) return NextResponse.json({ error: writeError.message }, { status: 500 })

  const deleted = done?.length ?? 0
  // alreadyDeleted = selected but not deleted by THIS request (gone before, or deleted by someone else in the meantime)
  return NextResponse.json({ ok: true, deleted, alreadyDeleted: parsed.ids.length - deleted })
}

