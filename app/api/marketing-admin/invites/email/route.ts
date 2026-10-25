import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"
import { previewInviteEmail, sendInviteEmail } from "@/lib/marketing/invite-email-server"

const NO_STORE = { "Cache-Control": "no-store" }

/**
 * POST /api/marketing-admin/invites/email — body { token, send?: boolean }. Antonio (the strict admin check) previews the invitation email (default) or sends it (`send: true`). Any team, any role.
 * The recipient is the email the invitation was made for; the token is the one-time link's own token.
 */
export async function POST(req: NextRequest) {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isSecureAdmin(user)) return NextResponse.json({ error: "Not allowed." }, { status: 403, headers: NO_STORE })
  const body = await req.json().catch(() => ({}))
  const scope = { teamId: null, allowOwnerInvite: true, actorLabel: user.email ?? user.id }
  const r = body.send === true ? await sendInviteEmail(body.token, scope, body.lang) : await previewInviteEmail(body.token, scope, body.lang)
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status, headers: NO_STORE })
  return NextResponse.json({ ok: true, ...r.data }, { headers: NO_STORE })
}
