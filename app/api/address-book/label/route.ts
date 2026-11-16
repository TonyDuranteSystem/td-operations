import { NextRequest } from "next/server"
import { BAD_BODY, fail, ok, readJsonObject, requireStaffJson } from "@/lib/address-book/access"
import { isUuid, respondError } from "@/lib/address-book/route-errors"
import { setCrmLabel } from "@/lib/address-book/store"

/**
 * Address book: Antonio's answer to "What is this person?" for a CRM person the CRM leaves "Not sorted yet" or "Other". Kept in the address book's own table only —
 * the Contacts data is never changed. Body: { kind: "contact", id, typeId } (typeId null takes the answer back). Any staff login.
 */
export const dynamic = "force-dynamic"

export async function POST(req: NextRequest) {
  const { denied, who } = await requireStaffJson(req)
  if (denied) return denied
  const body = await readJsonObject(req)
  if (!body) return fail(400, BAD_BODY)
  const kind = body.kind
  const id = body.id
  const rawType = body.typeId
  if (typeof kind !== "string" || !isUuid(id)) return fail(400, BAD_BODY)
  let typeId: string | null
  if (rawType === null) typeId = null
  else if (isUuid(rawType)) typeId = rawType
  else return fail(400, BAD_BODY)
  try {
    await setCrmLabel({ kind, id, typeId }, who)
    return ok({ ok: true })
  } catch (e) {
    return respondError(e, "POST /api/address-book/label")
  }
}
