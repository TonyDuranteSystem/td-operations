/**
 * Confirm — or discard — an action the assistant froze for approval.
 *
 * Antonio, 2026-07-20: "let it actually carry out actions rather than handing them back
 * to you." This is the click at the end of that: the staff member sees a card with the
 * exact action and values, presses Confirm, and it runs once.
 *
 * WHAT THIS ENDPOINT ACCEPTS: an id, and nothing else. Not the tool, not the values, not
 * a description. Everything that will run was frozen at propose time and is re-read from
 * the row here. If the payload travelled through the browser it could be edited on the
 * way, and the confirmation would no longer be a confirmation of what was shown.
 *
 * THE GUARDS, and why each one is here:
 *  · AUTH — staff only, re-checked on this request. The card was rendered in a panel the
 *    person was authenticated for, but a click arrives as its own request.
 *  · pending → approved as an ATOMIC compare-and-set. Two clicks, or a click racing a
 *    discard, produce one winner; the loser is told plainly rather than silently doing
 *    nothing. A read-then-write here would let a double-click run an action twice, which
 *    on "create an invoice" means two invoices.
 *  · The execute path then does its own atomic approved → executing claim, re-checks the
 *    integrity hash, and refuses client-facing sends. Those were reviewed and found sound
 *    on 2026-07-18; they are reused rather than reimplemented.
 *  · The action is recorded in the audit trail with the staff member who confirmed it —
 *    until now the catalog path wrote nothing at all, so there was no answer to "who told
 *    it to do that".
 *
 * RELATIONSHIP TO THE OLD RAIL'S KILL SWITCH. This calls executeApproval directly, which
 * is deliberately NOT gated by APPROVAL_RAIL_ENABLED — that switch guards
 * runApprovalExecutor, the CRON entry point that sweeps approved rows on its own. Sharing
 * the switch would mean turning on in-panel confirmation also re-animates the abandoned
 * rail's unattended sweep, which is the one thing Antonio ruled out ("it never has to act
 * autonomously"). This path only ever runs on a click, one row at a time, and has its own
 * switch (WORKER_PANEL_APPROVALS). The sweep stays off.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { confirmPendingAction } from '@/lib/ai-agent/panel-approvals'

export const dynamic = 'force-dynamic'
// Executing a confirmed action runs a real tool — same budget as the worker itself.
export const maxDuration = 300

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  let body: { id?: string; action?: 'confirm' | 'discard' }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const id = typeof body.id === 'string' ? body.id.trim() : ''
  const action = body.action === 'discard' ? 'discard' : 'confirm'
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: 'A valid action id is required.' }, { status: 400 })
  }

  // Everything that decides what happens lives in confirmPendingAction, so the whole
  // decision — including the double-click race — is exercisable against a real database.
  const outcome = await confirmPendingAction(id, user.email ?? user.id, action)

  if (outcome.ok === true) return NextResponse.json({ ok: true, status: outcome.status })
  // 409 for "someone already decided it" (the double-click / race case), 422 for an
  // action that genuinely ran and did not succeed — the panel words them differently.
  return NextResponse.json({ error: outcome.error }, { status: outcome.code === 'gone' ? 409 : 422 })
}
