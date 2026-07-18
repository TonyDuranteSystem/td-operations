import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { saveMarkedMessageAsMemory } from "@/lib/ai-agent/chat-memory-reaction"

export const dynamic = "force-dynamic"
// The distill step is one Sonnet call — well under the default, but give it room.
export const maxDuration = 60

/**
 * POST /api/inbox/worker-chat/remember — 🧠 a WORKER reply (Business Brain, dev
 * job 203cda1a).
 *
 * The Worker tab is the staff↔assistant panel; its turns live in agent_messages,
 * not portal_messages, so the existing message-reaction routes don't apply. Antonio
 * asked for the 🧠 button here because this is where the good reasoning happens.
 *
 * SECURITY: the body carries ONLY the message id. The reply text is re-read
 * server-side from that row — a browser can never post arbitrary text into the
 * shared (global) brain. Staff-only, same gate as the worker panel itself.
 *
 * Per Antonio's rule, 🧠 = make it GLOBAL: the reply is distilled into a general,
 * client-free rule (client names/amounts/ids stripped) before saving. Idempotent —
 * re-tapping the same reply won't double-save.
 */
export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  let body: { messageId?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const messageId = body.messageId?.trim()
  if (!messageId) {
    return NextResponse.json({ error: "messageId is required" }, { status: 400 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: row } = await db
    .from("agent_messages")
    .select("id, reply, status, recipient")
    .eq("id", messageId)
    .maybeSingle()

  if (!row) {
    return NextResponse.json({ error: "That message no longer exists." }, { status: 404 })
  }
  // Only a worker-panel turn that actually produced a reply can be remembered.
  if (row.recipient !== "worker" || row.status !== "done" || !row.reply?.trim()) {
    return NextResponse.json(
      { error: "That turn has no assistant reply to remember." },
      { status: 400 },
    )
  }

  const savedByName = user.email?.split("@")[0] || "TD Team"
  const result = await saveMarkedMessageAsMemory({
    messageText: row.reply,
    savedByName,
    surface: "worker",
    messageId: row.id,
  })

  if (result.saved) {
    return NextResponse.json({ saved: true })
  }

  // Say something TRUE rather than a generic failure (R099).
  const message =
    result.reason === "already_saved"
      ? "Already saved to memory."
      : result.reason === "nothing_general"
        ? "Nothing general enough to save as a rule — it looks specific to this client."
        : "Couldn't save that to memory. Please try again."
  // already_saved is not an error state for the user — it's the desired end state.
  return NextResponse.json(
    { saved: false, reason: result.reason, message },
    { status: result.reason === "already_saved" ? 200 : 422 },
  )
}
