/**
 * GET /api/storage-app/routes?owner=<id>[,<id>…] — for each of these person storages, the "company › 2. Contacts" places that show it:
 * `{ routes: [{ owner, company, folder }] }`. The Mac uses it to update the copy of a person's storage under each company when something changes,
 * without waiting for Finder to open that company's Contacts folder. A storage that is not a person's, or a company this login cannot open, gives nothing.
 * Token only; same access checks as the Storage page.
 */
export const dynamic = "force-dynamic"
import { NextRequest } from "next/server"
import { denyUnlessAreaAccess } from "@/app/api/crm-store/browse/_auth"
import { json, withDevice } from "@/lib/storage-app/guard"
import { liveOwnerIds } from "@/lib/storage-app/listing"
import { companyRoutesFor, parseOwnerList } from "@/lib/storage-app/routes"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(req: NextRequest) {
  return withDevice(req, async ({ user }) => {
    const owners = parseOwnerList(req.nextUrl.searchParams.get("owner"), (s) => UUID.test(s))
    if (owners.length === 0) return json({ error: "Choose a storage." }, 400)
    const live = await liveOwnerIds()
    // only storages this login may open (the same test as the folder route); a hidden or private one is skipped, never an error
    const mine: string[] = []
    for (const o of owners) if (live.has(o) && !(await denyUnlessAreaAccess({ ownerId: o }, { user }))) mine.push(o)
    const routes = await companyRoutesFor(mine, async (company) => !(await denyUnlessAreaAccess({ ownerId: company }, { user })), async () => live)
    return json({ routes })
  })
}
