import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"
import { previewResetEmail, sendResetEmail } from "@/lib/marketing/reset-email-server"

const NO_STORE = { "Cache-Control": "no-store" }

/**
 * POST /api/marketing-admin/resets/email — body { token, send?: boolean, lang? }. Antonio (the strict admin check) previews the password-reset email for the link he just made on the Teams page
 * (default) or sends it (`send: true`). The recipient is the login the link was made for; the token is the one-time link's own token.
 */
export async function POST(req: NextRequest) {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isSecureAdmin(user)) return NextResponse.json({ error: "Not allowed." }, { status: 403, headers: NO_STORE })
  const raw = await req.json().catch(() => null)
  const body = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const label = user.email ?? user.id
  const r = body.send === true ? await sendResetEmail(body.token, label, body.lang) : await previewResetEmail(body.token, label, body.lang)
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status, headers: NO_STORE })
  return NextResponse.json({ ok: true, ...r.data }, { headers: NO_STORE })
}
