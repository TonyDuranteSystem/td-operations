/**
 * GET  /api/crm-store/type-questions — the labels waiting for an answer (staff). { questions, canAnswer }
 * POST /api/crm-store/type-questions — "Look for unknown labels" (owners only, pilot environment).
 */
export const dynamic = "force-dynamic"
export const maxDuration = 120

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isOwnerOnly } from "@/lib/auth"
import { denyUnlessStoreStaff } from "../browse/_auth"

export async function GET() {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const { data: { user } } = await createClient().auth.getUser()
  try {
    const { listTypeQuestions } = await import("@/lib/crm-store/type-names")
    return NextResponse.json({ questions: await listTypeQuestions(), canAnswer: !!user && isOwnerOnly(user) })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read the questions." }, { status: 400 })
  }
}

export async function POST() {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isOwnerOnly(user)) return NextResponse.json({ error: "Owners only." }, { status: 403 })
  const { pilotEnvironmentAllowed } = await import("@/lib/crm-store/formation-pilot")
  const { studyCopyAllowed } = await import("@/lib/crm-store/drive-import")
  if (!pilotEnvironmentAllowed() && !studyCopyAllowed()) return NextResponse.json({ error: "The new storage is not switched on here." }, { status: 403 })
  try {
    const { scanUnknownTypeNames } = await import("@/lib/crm-store/type-names")
    return NextResponse.json(await scanUnknownTypeNames(user.id))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not look for unknown labels." }, { status: 400 })
  }
}
