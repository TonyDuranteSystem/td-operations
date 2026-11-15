import { NextRequest } from "next/server"
import { BAD_BODY, fail, ok, readJsonObject, requireStaff, requireStaffJson } from "@/lib/address-book/access"
import { respondError } from "@/lib/address-book/route-errors"
import { createType, listTypes } from "@/lib/address-book/type-admin"

/** Address book: the types Antonio made (GET) and a new one (POST: name, colour, boxes). Any staff login. No type is built in. */
export const dynamic = "force-dynamic"

export async function GET() {
  const { denied } = await requireStaff()
  if (denied) return denied
  try {
    return ok({ types: await listTypes() })
  } catch (e) {
    return respondError(e, "GET /api/address-book/types")
  }
}

export async function POST(req: NextRequest) {
  const { denied, who } = await requireStaffJson(req)
  if (denied) return denied
  const body = await readJsonObject(req)
  if (!body) return fail(400, BAD_BODY)
  try {
    const type = await createType({ name: body.name, color: body.color, boxes: body.boxes }, who.id)
    return ok({ type })
  } catch (e) {
    return respondError(e, "POST /api/address-book/types")
  }
}
