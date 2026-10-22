/** POST /api/store-devices/app-release/offer { enabled?, rolloutPercent? } — offer the published version to the Macs, pause it, or set the roll-out share. Owner only. */
export const dynamic = "force-dynamic"
import { NextRequest, NextResponse } from "next/server"
import { requirePublisher } from "@/lib/storage-app/publisher-guard"
import { loadRelease } from "@/lib/storage-app/release"
import { setOffering } from "@/lib/storage-app/release-publish"

export async function POST(req: NextRequest) {
  const who = await requirePublisher(req)
  if (who instanceof NextResponse) return who
  const b = (await req.json().catch(() => ({}))) as { enabled?: unknown; rolloutPercent?: unknown }
  const enabled = typeof b.enabled === "boolean" ? b.enabled : undefined
  const pct = typeof b.rolloutPercent === "number" && Number.isFinite(b.rolloutPercent) ? b.rolloutPercent : undefined
  if (enabled === undefined && pct === undefined) return NextResponse.json({ error: "Nothing to change." }, { status: 400 })
  try {
    const rel = await setOffering(await loadRelease(), { enabled, rolloutPercent: pct }, who.user.email ?? who.user.id)
    return NextResponse.json({ ok: true, enabled: rel.enabled, rolloutPercent: rel.rolloutPercent }, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error && e.message ? e.message : "Could not change that. Try again." }, { status: 422 })
  }
}
