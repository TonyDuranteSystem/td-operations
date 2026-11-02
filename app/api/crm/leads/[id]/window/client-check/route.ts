/**
 * POST /api/crm/leads/[id]/window/client-check   body: { contactId: uuid, answer: "client" | "new_lead" | "later" }
 *
 * Antonio's answer to "is this lead already a client?" (dev job 6fc63c52). "client" links the lead to that contact and
 * teaches the contact the email and phone the lead used; "new_lead" is remembered so the question is not asked again;
 * "later" keeps it open. Staff only.
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { answerClientCheck, ANSWERS } from "@/lib/leads/client-check-answer"
import type { AnswerStatus } from "@/lib/leads/client-context"

export const dynamic = "force-dynamic"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  if (!UUID.test(params.id)) return NextResponse.json({ error: "That is not a valid lead id." }, { status: 400 })

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const contactId = typeof body.contactId === "string" ? body.contactId : ""
  const answer = body.answer as AnswerStatus
  if (!UUID.test(contactId)) return NextResponse.json({ error: "That is not a valid contact id." }, { status: 400 })
  if (ANSWERS.indexOf(answer) === -1) return NextResponse.json({ error: "The answer must be client, new_lead or later." }, { status: 400 })

  try {
    const { data: { user } } = await createClient().auth.getUser()
    const actor = user?.email?.split("@")[0] ?? "staff"
    const result = await answerClientCheck(supabaseAdmin, { leadId: params.id, contactId, answer, actor })
    return NextResponse.json({ ok: result.ok, message: result.message, learned: result.learned ?? null }, { status: result.status })
  } catch (err) {
    console.error("[leads/window/client-check] unexpected error:", err)
    return NextResponse.json({ error: "Could not save your answer — please try again." }, { status: 500 })
  }
}
