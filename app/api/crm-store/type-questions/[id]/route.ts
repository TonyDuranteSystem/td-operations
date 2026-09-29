/**
 * POST /api/crm-store/type-questions/<id> — answer a label question (owners only, pilot environment).
 * Body { answer: "same", type } | { answer: "new", folderKind, name? } | { answer: "reject" }.
 */
export const dynamic = "force-dynamic"

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isOwnerOnly } from "@/lib/auth"

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isOwnerOnly(user)) return NextResponse.json({ error: "Owners only." }, { status: 403 })
  const { pilotEnvironmentAllowed } = await import("@/lib/crm-store/formation-pilot")
  const { studyCopyAllowed } = await import("@/lib/crm-store/drive-import")
  if (!pilotEnvironmentAllowed() && !studyCopyAllowed()) return NextResponse.json({ error: "The new storage is not switched on here." }, { status: 403 })
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const { answerTypeQuestion } = await import("@/lib/crm-store/type-names")
  try {
    if (b.answer === "same" && typeof b.type === "string") return NextResponse.json(await answerTypeQuestion(params.id, { kind: "same", typeSlug: b.type }, user.id))
    if (b.answer === "new" && typeof b.folderKind === "string") return NextResponse.json(await answerTypeQuestion(params.id, { kind: "new", folderKind: b.folderKind, name: typeof b.name === "string" ? b.name : undefined }, user.id))
    if (b.answer === "reject") return NextResponse.json(await answerTypeQuestion(params.id, { kind: "reject" }, user.id))
    return NextResponse.json({ error: "Choose an answer." }, { status: 400 })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The answer could not be saved." }, { status: 400 })
  }
}
