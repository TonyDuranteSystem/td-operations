import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"

/**
 * GET /api/client-threads/[id]/messages
 * Returns the messages of a client_thread's conversation. Staff-only.
 *
 * OUR OWN COPY FIRST (2026-07-30, Antonio: "we have to use team chat, not Slack").
 * This used to read LIVE from Slack on every open, with a stored copy kept only for
 * closed conversations — so an open one existed nowhere but Slack, and switching the
 * Slack app off would have emptied 116 of them. The rescue job archives them here;
 * this route now prefers that archive whatever the status, and only falls back to
 * Slack for a row that has not been archived yet. Once the archive is complete the
 * Slack call is dead weight and goes with the rest of the Slack surface.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: row, error } = await db
    .from("client_threads")
    .select("source, source_ref, status, transcript")
    .eq("id", params.id)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })

  // ARCHIVED → serve our own copy, open or closed. Independent of Slack, and the
  // same shape the panel already renders.
  if (Array.isArray(row.transcript) && row.transcript.length > 0) {
    return NextResponse.json({ messages: row.transcript, closed: row.status === "closed", archived: true })
  }

  // Backfilled CRM-log rows: source_ref is a conversations row id — return its
  // stored message/response so the historical entry is readable here too.
  if (row.source === "crm_log" && typeof row.source_ref === "string") {
    const { data: conv } = await db
      .from("conversations")
      .select("client_message, response_sent, handled_by, channel, created_at")
      .eq("id", row.source_ref)
      .maybeSingle()
    const messages: Array<{ author: string; text: string; ts: string }> = []
    if (conv?.client_message) messages.push({ author: "Client", text: conv.client_message, ts: "" })
    if (conv?.response_sent) messages.push({ author: conv.handled_by || "Team", text: conv.response_sent, ts: "" })
    return NextResponse.json({ messages, channel: conv?.channel ?? null })
  }

  // Closed with no archive of its own. This check sits AFTER the CRM-log branch on
  // purpose: those rows keep their content in the conversation log, not in a
  // snapshot, so closing one must not hide text that is still there and still shown
  // on the account's Activity tab. Two screens disagreeing about whether a
  // conversation exists is worse than either answer.
  if (row.status === "closed") {
    return NextResponse.json({ messages: [], closed: true, note: "No stored copy of this conversation." })
  }

  // NO LIVE SLACK READ. It used to fall through to Slack here for an open
  // conversation; with the Slack surface removed that call can only fail, and a
  // silent [] would read as "this conversation was empty" rather than "we never
  // copied it". Say which it is.
  return NextResponse.json({
    messages: [],
    note: "No stored copy of this conversation.",
  })
}
