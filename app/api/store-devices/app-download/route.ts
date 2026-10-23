/** GET /api/store-devices/app-download — the CRM page "TD Storage install" sends the person here: a 60-second link to the newest app zip. Cookie login; admins and the allowed staff only. */
export const dynamic = "force-dynamic"
import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { denyUnlessStoreStaff } from "@/app/api/crm-store/browse/_auth"
import { canSeeInstallPage } from "@/lib/storage-app/install-access"
import { DOWNLOAD_LINK_SECONDS, loadRelease, signedZipUrl } from "@/lib/storage-app/release"

export async function GET() {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const { data: { user } } = await createClient().auth.getUser()
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 })
  if (!(await canSeeInstallPage(user))) return NextResponse.json({ error: "The TD Storage app is not available to this login." }, { status: 403 })
  const rel = await loadRelease()
  if (!rel) return NextResponse.json({ error: "No version of the app is published yet." }, { status: 404 })
  const url = await signedZipUrl(rel, DOWNLOAD_LINK_SECONDS, `TDStorage-${rel.version}.zip`)
  if (!url) return NextResponse.json({ error: "Could not prepare the download. Try again." }, { status: 500 })
  return NextResponse.redirect(url, { headers: { "Cache-Control": "no-store" } })
}
