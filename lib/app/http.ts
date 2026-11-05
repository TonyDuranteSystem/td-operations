/**
 * TD Social — small response helper shared by the routes under /api/marketing/app/ (server; dev job 2072bc3e).
 * Every answer is `no-store`: who a person is and what they may see must never be kept by a cache.
 */
import { NextResponse } from "next/server"

export function appJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } })
}
