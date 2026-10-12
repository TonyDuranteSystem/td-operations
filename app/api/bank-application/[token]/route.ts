/**
 * GET  /api/bank-application/[token] — what state is this link in?  (never claims it)
 * POST /api/bank-application/[token] — the visitor pressed "Start": THIS is what claims the link.
 *
 * Claiming needs a deliberate POST so a link-preview bot, a mail scanner or an in-app browser that
 * only loads the page cannot burn the link. The first browser to POST becomes the link's only owner
 * (a secret cookie, only its hash stored). The same browser may come back until it submits; everyone
 * else, and everyone after a submit or revoke, gets { state: "used" }. Nothing about the application
 * is ever returned — only the state.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { attachOwnerCookie, gateLink } from "@/lib/bofa-intake/access"

type Params = { params: Promise<{ token: string }> }

function stateResponse(gate: Awaited<ReturnType<typeof gateLink>>) {
  if ("reason" in gate) {
    if (gate.reason === "missing") return NextResponse.json({ state: "missing" }, { status: 404 })
    if (gate.reason === "error") return NextResponse.json({ state: "error" }, { status: 503 })
    if (gate.reason === "pending") return NextResponse.json({ state: "start" })
    return NextResponse.json({ state: "used" })
  }
  return null
}

export async function GET(req: NextRequest, { params }: Params) {
  const { token } = await params
  const gate = await gateLink(req, token, false)
  const early = stateResponse(gate)
  const res = early ?? NextResponse.json({ state: "form" })
  res.headers.set("Cache-Control", "no-store")
  return res
}

export async function POST(req: NextRequest, { params }: Params) {
  const { token } = await params
  const gate = await gateLink(req, token, true)
  const early = stateResponse(gate)
  if (early) {
    early.headers.set("Cache-Control", "no-store")
    return early
  }
  const res = NextResponse.json({ state: "form" })
  if ("claimedSecret" in gate && gate.claimedSecret) attachOwnerCookie(res, token, gate.claimedSecret)
  res.headers.set("Cache-Control", "no-store")
  return res
}
