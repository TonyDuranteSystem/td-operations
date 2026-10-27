/** POST /api/store-devices/app-release/prepare { version, build, length } — step 1 of publishing: a one-time upload address for the zip. Owner only (see publisher-guard). */
export const dynamic = "force-dynamic"
import { NextRequest, NextResponse } from "next/server"
import { requirePublisher } from "@/lib/storage-app/publisher-guard"
import { prepareUpload } from "@/lib/storage-app/release-publish"

export async function POST(req: NextRequest) {
  const who = await requirePublisher(req)
  if (who instanceof NextResponse) return who
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const r = await prepareUpload(b)
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status })
  return NextResponse.json({ path: r.path, token: r.token }, { headers: { "Cache-Control": "no-store" } })
}
