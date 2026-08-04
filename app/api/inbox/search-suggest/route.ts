import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { checkMailboxAccess } from "@/lib/inbox/mailbox-access"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { buildPrefixTsQuery, shouldSuggest, SUGGEST_LIMIT } from "@/lib/inbox/search-suggest"

export const dynamic = "force-dynamic"

/**
 * GET /api/inbox/search-suggest?q=...&mailbox=support
 *
 * The type-ahead behind the inbox search box. Answers from OUR index only —
 * never live Gmail — because this fires while the user types and Gmail costs
 * seconds plus quota the interactive inbox needs (the 2026-08-02 self-rate-limit
 * incident). Operator queries (from:, has:) are filtered out client- and
 * server-side and keep the existing press-Enter path into live Gmail.
 */
export async function GET(req: NextRequest) {
  // Staff only, and only the mailboxes this person may read — antonio@ is
  // personal. /api/* inherits just "is logged in" from middleware, so both
  // gates are this route's own job.
  const denied = await requireStaffRoute()
  if (denied) return denied

  const mailboxParam = req.nextUrl.searchParams.get("mailbox")
  if (!(await checkMailboxAccess(mailboxParam))) {
    return NextResponse.json({ error: "Not authorized for this mailbox" }, { status: 403 })
  }
  const mailbox = mailboxParam === "antonio" ? "antonio" : "support"

  const q = req.nextUrl.searchParams.get("q")
  // Not an error — "nothing to suggest yet" is the normal state while typing.
  if (!shouldSuggest(q)) return NextResponse.json({ suggestions: [] })
  const tsquery = buildPrefixTsQuery(q)
  if (!tsquery) return NextResponse.json({ suggestions: [] })

  try {
    // This function is newer than the generated DB types (same escape the email
    // tables use in lib/email-store).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabaseAdmin as any).rpc("inbox_search_suggest", {
      p_mailbox: mailbox,
      p_tsquery: tsquery,
      p_limit: SUGGEST_LIMIT,
    })
    if (error) throw new Error(error.message)

    const rows = (data ?? []) as Array<{
      message_id: string
      thread_id: string
      subject: string | null
      from_name: string | null
      from_email: string | null
      internal_date: string | null
      has_attachment: boolean | null
      is_unread: boolean | null
    }>

    return NextResponse.json({
      suggestions: rows.map((r) => ({
        // The id shape the conversation list and thread view already speak.
        id: `gmail:${r.thread_id}`,
        threadId: r.thread_id,
        subject: r.subject || "(no subject)",
        sender: r.from_name || r.from_email || "",
        senderEmail: r.from_email || "",
        date: r.internal_date,
        hasAttachment: Boolean(r.has_attachment),
        unread: Boolean(r.is_unread),
      })),
    })
  } catch (err) {
    // A dead dropdown must never break the search box itself: the user can still
    // press Enter and get the full result list. Log it, return empty.
    console.error("[inbox] search-suggest failed:", err)
    return NextResponse.json(
      { suggestions: [], error: "Suggestions are unavailable — press Enter to search." },
      { status: 200 },
    )
  }
}
