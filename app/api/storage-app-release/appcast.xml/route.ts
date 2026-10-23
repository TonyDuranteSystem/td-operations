/**
 * GET /api/storage-app-release/appcast.xml — the update feed the TD Storage Mac app (Sparkle) reads. PUBLIC by design (the app has no
 * login for this call, and the answer is only "which version exists", never a client's data): what makes an update safe is the signature —
 * the app installs nothing that was not signed with our key. Which version is offered, to whom, and whether updates are paused is the
 * `storage_app_release` settings row (lib/storage-app/release.ts); the zip link in the answer is signed and lasts 10 minutes.
 * It sits outside /api/storage-app on purpose: every route there is device-guarded and cookie-free (tests/unit/storage-app-routes.test.ts).
 */
export const dynamic = "force-dynamic"
import { NextRequest, NextResponse } from "next/server"
import { FEED_LINK_SECONDS, buildAppcast, isOffered, loadRelease, signedZipUrl } from "@/lib/storage-app/release"

const HEADERS = { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "no-store" }

export async function GET(req: NextRequest) {
  const rel = await loadRelease()
  const device = (req.nextUrl.searchParams.get("device") ?? "").slice(0, 80) || null
  if (!rel || !isOffered(rel, device)) return new NextResponse(buildAppcast(null, null), { headers: HEADERS })
  const url = await signedZipUrl(rel, FEED_LINK_SECONDS)
  return new NextResponse(buildAppcast(rel, url), { headers: HEADERS })
}
