import { NextRequest } from "next/server"
import { BAD_BODY, fail, ok, readJsonObject, requireStaffJson } from "@/lib/address-book/access"
import { isUuid, respondError } from "@/lib/address-book/route-errors"
import { archivePerson, updatePerson } from "@/lib/address-book/store"

/** Address book: change a saved person (PATCH) or take them out of the lists (DELETE keeps the row, marked archived). Any staff login. */
export const dynamic = "force-dynamic"

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const { denied } = await requireStaffJson(req)
  if (denied) return denied
  if (!isUuid(params.id)) return fail(404, "That person was not found. Reload the page.")
  const body = await readJsonObject(req)
  if (!body) return fail(400, BAD_BODY)
  const { force, ...person } = body
  delete person.source
  try {
    await updatePerson(params.id, person, { force: force === true })
    return ok({ ok: true })
  } catch (e) {
    return respondError(e, "PATCH /api/address-book/people/[id]")
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const { denied } = await requireStaffJson(req)
  if (denied) return denied
  if (!isUuid(params.id)) return fail(404, "That person was not found. Reload the page.")
  try {
    await archivePerson(params.id)
    return ok({ ok: true })
  } catch (e) {
    return respondError(e, "DELETE /api/address-book/people/[id]")
  }
}
