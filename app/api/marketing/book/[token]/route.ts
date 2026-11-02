import { NextRequest, NextResponse } from "next/server"
import { liveJointEnv } from "@/lib/marketing/joint-live"
import { bookJoint, cancelJoint, moveJoint, viewJointLink } from "@/lib/marketing/joint-booking"
import { GENERIC_LINK_ERROR } from "@/lib/marketing/joint-rules"

const NO_STORE = { "Cache-Control": "no-store" }
// the answers the client sees are written for the client (never a database or Google message): an unexpected failure is one plain sentence
const TRY_AGAIN = "Something went wrong. Please try again in a moment."

/** GET /api/marketing/book/[token] — PUBLIC (the link is the key): the free times, or the booked call, for this one link. Start times only; never why a time is not offered. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    return NextResponse.json(await viewJointLink(liveJointEnv(), token, { moveTimes: req.nextUrl.searchParams.get("move") === "1" }), { headers: NO_STORE })
  } catch (e) {
    console.error("[marketing] joint link view failed:", e instanceof Error ? e.message : e)
    return NextResponse.json({ state: "unusable" }, { status: 200, headers: NO_STORE })
  }
}

/** POST /api/marketing/book/[token] — PUBLIC: book, move or cancel the call of this one link. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const body = (await req.json().catch(() => null)) as { action?: unknown; startIso?: unknown; name?: unknown; email?: unknown; zone?: unknown } | null
    if (!body || typeof body.action !== "string") return NextResponse.json({ error: GENERIC_LINK_ERROR }, { status: 400, headers: NO_STORE })
    const env = liveJointEnv()
    if (body.action === "book") {
      const r = await bookJoint(env, token, { startIso: body.startIso, name: body.name, email: body.email, zone: body.zone })
      if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status, headers: NO_STORE })
      return NextResponse.json({ ok: true, startIso: r.startIso, endIso: r.endIso, joinUrl: r.joinUrl, mailed: r.mailed }, { headers: NO_STORE })
    }
    if (body.action === "move") {
      const r = await moveJoint(env, token, { startIso: body.startIso })
      if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status, headers: NO_STORE })
      return NextResponse.json({ ok: true, startIso: r.startIso, endIso: r.endIso, joinUrl: r.joinUrl }, { headers: NO_STORE })
    }
    if (body.action === "cancel") {
      const r = await cancelJoint(env, token)
      if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status, headers: NO_STORE })
      return NextResponse.json({ ok: true }, { headers: NO_STORE })
    }
    return NextResponse.json({ error: GENERIC_LINK_ERROR }, { status: 400, headers: NO_STORE })
  } catch (e) {
    console.error("[marketing] joint link action failed:", e instanceof Error ? e.message : e)
    return NextResponse.json({ error: TRY_AGAIN }, { status: 500, headers: NO_STORE })
  }
}
