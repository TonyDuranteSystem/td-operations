import { NextRequest } from "next/server"
import { BAD_BODY, fail, ok, readJsonObject, requireStaffJson } from "@/lib/address-book/access"
import { respondError } from "@/lib/address-book/route-errors"
import { createPerson } from "@/lib/address-book/store"

/**
 * Address book: save a person who has no place in the CRM. Any staff login. Nothing here touches the Contacts data.
 * Body: the person (full_name, company, phones, emails, …, type_entry_id, extra) plus `force: true` to save although the phone or email is already known (answered 409 with the matches otherwise).
 */
export const dynamic = "force-dynamic"

export async function POST(req: NextRequest) {
  const { denied, who } = await requireStaffJson(req)
  if (denied) return denied
  const body = await readJsonObject(req)
  if (!body) return fail(400, BAD_BODY)
  const { force, source, ...person } = body
  try {
    const r = await createPerson(person, who, { force: force === true, source: typeof source === "string" ? source : undefined })
    return ok({ id: r.id })
  } catch (e) {
    return respondError(e, "POST /api/address-book/people")
  }
}
