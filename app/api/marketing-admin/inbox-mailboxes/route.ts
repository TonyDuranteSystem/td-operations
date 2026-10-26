import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"
import { getTeam } from "@/lib/marketing/settings"
import { addMailbox, checkMailbox, removeMailbox, updateMailbox } from "@/lib/marketing/inbox/admin"

export const dynamic = "force-dynamic"
const NO_STORE = { "Cache-Control": "no-store" }

/**
 * POST /api/marketing-admin/inbox-mailboxes — Antonio only (the strict admin check; a team owner can NOT add an address, because the system's Gmail key can open any company mailbox).
 * body { teamId, action: "check" | "add" | "update" | "remove", address, people?, signature? }.
 */
export async function POST(req: NextRequest) {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isSecureAdmin(user)) return NextResponse.json({ error: "Not allowed." }, { status: 403, headers: NO_STORE })
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return NextResponse.json({ error: "Send JSON." }, { status: 415, headers: NO_STORE })
  const body = await req.json().catch(() => ({})) as { teamId?: unknown; action?: unknown; address?: unknown; people?: unknown; signature?: unknown }
  if (typeof body.teamId !== "string" || !(await getTeam(body.teamId))) return NextResponse.json({ error: "Pick a team." }, { status: 400, headers: NO_STORE })
  const actor = user.email ?? user.id
  const r =
    body.action === "check" ? await checkMailbox(body.teamId, body.address)
    : body.action === "add" ? await addMailbox({ teamId: body.teamId, address: body.address, people: body.people, signature: body.signature, actor })
    : body.action === "update" ? await updateMailbox({ teamId: body.teamId, address: body.address, people: body.people, signature: body.signature, actor })
    : body.action === "remove" ? await removeMailbox({ teamId: body.teamId, address: body.address, actor })
    : { ok: false as const, error: "Unknown action." }
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: 400, headers: NO_STORE })
  return NextResponse.json({ ok: true, data: r.data }, { headers: NO_STORE })
}
