import { NextRequest, NextResponse } from "next/server"
import { requireMarketing } from "@/lib/marketing/guard"
import { liveZoomHostTest } from "@/lib/marketing/zoom-test"

const NO_STORE = { "Cache-Control": "no-store" }

/** POST /api/marketing/team/zoom-test { host } — Antonio's "Test Zoom" button: one test meeting for that Zoom login, deleted at once, plus a check that the app may read its recordings. Only Antonio, never in "View as". */
export async function POST(req: NextRequest) {
  const g = await requireMarketing()
  if (g.res) return g.res
  if (g.ctx.admin !== true || g.ctx.viewAs) return NextResponse.json({ error: "Only Antonio can test Zoom, on his own login." }, { status: 403, headers: NO_STORE })
  const body = (await req.json().catch(() => null)) as { host?: unknown } | null
  const host = typeof body?.host === "string" ? body.host.trim().slice(0, 200) : ""
  if (!host) return NextResponse.json({ error: "Give the Zoom login email to test." }, { status: 400, headers: NO_STORE })
  try {
    return NextResponse.json(await liveZoomHostTest(host), { headers: NO_STORE })
  } catch (e) {
    console.error("[marketing] zoom test failed:", e instanceof Error ? e.message : e)
    return NextResponse.json({ error: "The test could not run. Please try again." }, { status: 500, headers: NO_STORE })
  }
}
