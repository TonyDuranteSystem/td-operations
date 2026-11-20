import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"

export const dynamic = "force-dynamic"

/**
 * Which company a WhatsApp GROUP belongs to (Antonio 2026-11-20: "linking a group to a client or company").
 * A one-to-one chat is linked to a person through the match bar; a group has many people, so it is linked to a COMPANY (account) directly.
 * Linking only sets `messaging_groups.account_id` — it never renames the group and never touches the company. Once linked, the chat's
 * "Create task / service / invoice", team discussion and notes attach to that company, exactly as for a linked one-to-one chat.
 *
 * GET  ?groupId=…                  → { isGroup, accountId, accountName }
 * POST { groupId, accountId|null } → link (or unlink with null) → { accountId, accountName }
 * Staff only (a portal client has a login too).
 */
async function readGroup(groupId: string) {
  const { data: group } = await supabaseAdmin.from("messaging_groups").select("id, external_group_id, account_id").eq("id", groupId).maybeSingle()
  return group
}

async function companyName(accountId: string | null): Promise<string | null> {
  if (!accountId) return null
  const { data } = await supabaseAdmin.from("accounts").select("company_name").eq("id", accountId).maybeSingle()
  return data?.company_name ?? null
}

export async function GET(request: NextRequest) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  const groupId = request.nextUrl.searchParams.get("groupId")
  if (!groupId) return NextResponse.json({ error: "groupId is required" }, { status: 400 })
  const group = await readGroup(groupId)
  if (!group) return NextResponse.json({ error: "Conversation not found" }, { status: 404 })
  const isGroup = (group.external_group_id ?? "").endsWith("@g.us")
  return NextResponse.json({ isGroup, accountId: group.account_id ?? null, accountName: isGroup ? await companyName(group.account_id ?? null) : null })
}

export async function POST(request: NextRequest) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  let body: { groupId?: unknown; accountId?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 })
  }
  const groupId = typeof body.groupId === "string" ? body.groupId : ""
  const accountId = body.accountId === null ? null : typeof body.accountId === "string" ? body.accountId : undefined
  if (!groupId || accountId === undefined) return NextResponse.json({ error: "groupId and accountId (or null) are required" }, { status: 400 })

  const group = await readGroup(groupId)
  if (!group) return NextResponse.json({ error: "Conversation not found" }, { status: 404 })
  if (!(group.external_group_id ?? "").endsWith("@g.us")) {
    return NextResponse.json({ error: "Only a WhatsApp group can be linked to a company here — link a one-to-one chat from its match bar." }, { status: 400 })
  }
  let name: string | null = null
  if (accountId) {
    const { data: account } = await supabaseAdmin.from("accounts").select("id, company_name").eq("id", accountId).maybeSingle()
    if (!account) return NextResponse.json({ error: "That company was not found." }, { status: 404 })
    name = account.company_name ?? null
  }
  const { error } = await supabaseAdmin.from("messaging_groups").update({ account_id: accountId }).eq("id", groupId)
  if (error) return NextResponse.json({ error: "Could not save the link — please try again." }, { status: 500 })
  return NextResponse.json({ accountId, accountName: name })
}
