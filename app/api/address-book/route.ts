import { loadAddressBook } from "@/lib/address-book/store"
import { ok, requireStaff } from "@/lib/address-book/access"
import { respondError } from "@/lib/address-book/route-errors"

/** Address book: every person (CRM people read only, plus the people saved here) and every type. Any staff login. */
export const dynamic = "force-dynamic"

export async function GET() {
  const { denied } = await requireStaff()
  if (denied) return denied
  try {
    const data = await loadAddressBook()
    return ok({ rows: data.rows, types: data.types })
  } catch (e) {
    return respondError(e, "GET /api/address-book")
  }
}
