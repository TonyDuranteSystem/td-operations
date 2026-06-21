import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { fetchSlackThreadMessages } from "@/lib/ai-agent/slack-claude"

/**
 * GET /api/client-threads/[id]/messages
 * Returns the messages of a client_thread's conversation, pulled LIVE from Slack
 * (conversations.replies) when expanded in the CRM panel. Staff-only. No stored
 * copy — always current; empty if the Slack thread was deleted.
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
    .select("source, source_ref")
    .eq("id", params.id)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })

  if (row.source !== "slack" || typeof row.source_ref !== "string" || !row.source_ref.includes(":")) {
    // Non-Slack source (e.g. backfilled crm_log) has no live thread to fetch.
    return NextResponse.json({ messages: [], note: "No Slack thread for this conversation." })
  }

  const [channelId, threadTs] = row.source_ref.split(":")
  const messages = await fetchSlackThreadMessages(channelId, threadTs)
  return NextResponse.json({ messages })
}
