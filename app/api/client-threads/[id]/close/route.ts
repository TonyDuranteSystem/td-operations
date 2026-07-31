import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { closeClientThread, reopenClientThread } from "@/lib/ai-agent/client-thread-actions"

/**
 * POST /api/client-threads/[id]/close        → close (snapshot + status='closed')
 * POST /api/client-threads/[id]/close?reopen=1 → reopen (back to live)
 * Staff-only.
 */
export async function POST(
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

  const reopen = req.nextUrl.searchParams.get("reopen") === "1"
  const result = reopen ? await reopenClientThread(params.id) : await closeClientThread(params.id, user.id)
  if (!result.ok) return NextResponse.json({ error: result.error ?? "Failed" }, { status: 500 })
  return NextResponse.json({ ok: true, status: reopen ? "open" : "closed" })
}
