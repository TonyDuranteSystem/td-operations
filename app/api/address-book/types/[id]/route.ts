import { NextRequest } from "next/server"
import { BAD_BODY, fail, ok, readJsonObject, requireStaffJson } from "@/lib/address-book/access"
import { isUuid, respondError } from "@/lib/address-book/route-errors"
import { updateType } from "@/lib/address-book/type-admin"

/** Address book: change a type — its name, colour, boxes, or hide / show it. A type is never deleted. Any staff login. */
export const dynamic = "force-dynamic"

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const { denied, who } = await requireStaffJson(req)
  if (denied) return denied
  if (!isUuid(params.id)) return fail(404, "That type was not found. Reload the page.")
  const body = await readJsonObject(req)
  if (!body) return fail(400, BAD_BODY)
  try {
    const type = await updateType(params.id, { name: body.name, color: body.color, boxes: body.boxes, hidden: body.hidden }, who.id)
    return ok({ type })
  } catch (e) {
    return respondError(e, "PATCH /api/address-book/types/[id]")
  }
}
