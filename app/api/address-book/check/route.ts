import { NextRequest } from "next/server"
import { BAD_BODY, fail, ok, readJsonObject, requireStaffJson } from "@/lib/address-book/access"
import { isUuid, respondError } from "@/lib/address-book/route-errors"
import { findMatches } from "@/lib/address-book/store"

/** Address book: "is this phone or email already here?" — answers with the CRM people and saved people that hold it. Reads only. Any staff login. */
export const dynamic = "force-dynamic"

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 12) : [])

export async function POST(req: NextRequest) {
  const { denied } = await requireStaffJson(req)
  if (denied) return denied
  const body = await readJsonObject(req)
  if (!body) return fail(400, BAD_BODY)
  try {
    const matches = await findMatches({ phones: list(body.phones), emails: list(body.emails), exceptSavedId: isUuid(body.exceptSavedId) ? body.exceptSavedId : undefined })
    return ok({ matches })
  } catch (e) {
    return respondError(e, "POST /api/address-book/check")
  }
}
