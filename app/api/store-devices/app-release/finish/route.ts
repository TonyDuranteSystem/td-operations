/** POST /api/store-devices/app-release/finish { package } — step 2: checks the uploaded zip (size + signature against our public key) and stores the release PAUSED. Owner only. */
export const dynamic = "force-dynamic"
import { NextRequest, NextResponse } from "next/server"
import { requirePublisher } from "@/lib/storage-app/publisher-guard"
import { loadRelease } from "@/lib/storage-app/release"
import { acceptUpload, parseReleasePackage } from "@/lib/storage-app/release-publish"

export async function POST(req: NextRequest) {
  const who = await requirePublisher(req)
  if (who instanceof NextResponse) return who
  const b = (await req.json().catch(() => ({}))) as { package?: unknown }
  const pkg = parseReleasePackage(b.package)
  if (!pkg) return NextResponse.json({ error: "That is not a TD Storage release package file." }, { status: 400 })
  try {
    const rel = await acceptUpload(pkg, await loadRelease(), who.user.email ?? who.user.id)
    return NextResponse.json({ ok: true, version: rel.version, build: rel.build, enabled: rel.enabled }, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error && e.message ? e.message : "Could not publish. Try again." }, { status: 422 })
  }
}
