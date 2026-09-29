/**
 * POST /api/crm-store/browse/file/<id>/type — set or correct a file's document type (new CRM store, staff only,
 * pilot environment only). Body { type, personContactId?, companyOwnerId?, filedAnswer?, viewingOwnerId? }.
 * 409 { question } = an answer is needed first (whose document / which company / is it the filed copy) — nothing changed.
 */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { denyUnlessStoreStaff, denyUnlessStorePilotEnv, denyUnlessAreaAccess } from "../../../_auth"

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null)

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = (await denyUnlessStoreStaff()) ?? (await denyUnlessStorePilotEnv())
  if (denied) return denied
  const noAccess = await denyUnlessAreaAccess({ fileId: params.id })
  if (noAccess) return noAccess
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const type = str(body.type)
  if (!type) return NextResponse.json({ error: "Choose a document type." }, { status: 400 })
  const filed = body.filedAnswer === "filed" || body.filedAnswer === "hide" ? body.filedAnswer : null
  const { data: { user } } = await createClient().auth.getUser()
  const { setStoreFileType, SetTypeQuestionError } = await import("@/lib/crm-store/set-type")
  try {
    const r = await setStoreFileType({
      fileId: params.id, typeSlug: type, actorId: user?.id ?? null, personContactId: str(body.personContactId),
      companyOwnerId: str(body.companyOwnerId), filedAnswer: filed, viewingOwnerId: str(body.viewingOwnerId),
    })
    return NextResponse.json(r)
  } catch (e) {
    if (e instanceof SetTypeQuestionError) return NextResponse.json({ question: e.question }, { status: 409 })
    return NextResponse.json({ error: e instanceof Error ? e.message : "The type could not be set." }, { status: 400 })
  }
}
