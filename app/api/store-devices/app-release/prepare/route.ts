/** POST /api/store-devices/app-release/prepare { version, build, length } — step 1 of publishing: a one-time upload address for the zip. Owner only (see publisher-guard). */
export const dynamic = "force-dynamic"
import { NextRequest, NextResponse } from "next/server"
import { requirePublisher } from "@/lib/storage-app/publisher-guard"
import { RELEASE_BUCKET, loadRelease, parseRelease } from "@/lib/storage-app/release"
import { buildIsNewer, ensureBucket, zipPathFor } from "@/lib/storage-app/release-publish"
import { supabaseAdmin } from "@/lib/supabase-admin"

export async function POST(req: NextRequest) {
  const who = await requirePublisher(req)
  if (who instanceof NextResponse) return who
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const check = parseRelease({ version: b.version, build: b.build, edSignature: "x", length: b.length, path: "x/x.zip", enabled: false })
  if (!check) return NextResponse.json({ error: "The package file is not valid (version, build or size)." }, { status: 400 })
  if (check.length > 200 * 1024 * 1024) return NextResponse.json({ error: "The zip is too big (over 200 MB)." }, { status: 400 })
  const current = await loadRelease()
  if (!buildIsNewer(current, check.build)) return NextResponse.json({ error: `Build ${check.build} is not newer than the published build ${current?.build}. Make a new build number.` }, { status: 409 })
  try { await ensureBucket() } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Could not prepare the upload." }, { status: 500 }) }
  const path = zipPathFor(check.version)
  const { data, error } = await supabaseAdmin.storage.from(RELEASE_BUCKET).createSignedUploadUrl(path, { upsert: true })
  if (error || !data) return NextResponse.json({ error: "Could not prepare the upload. Try again." }, { status: 500 })
  return NextResponse.json({ path, token: data.token }, { headers: { "Cache-Control": "no-store" } })
}
