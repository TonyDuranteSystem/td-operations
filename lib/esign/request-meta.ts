/**
 * Server-side request metadata for the e-sign audit trail. IP and user-agent
 * MUST be read here (server), never trusted from the client body, so the legal
 * trail can't be spoofed. Behind Vercel, the client IP is the first entry of
 * x-forwarded-for.
 */
import type { NextRequest } from "next/server"

export function clientIp(req: NextRequest): string | null {
  const fwd = req.headers.get("x-forwarded-for")
  if (fwd) {
    const first = fwd.split(",")[0]?.trim()
    if (first) return first
  }
  return req.headers.get("x-real-ip") || null
}

export function userAgent(req: NextRequest): string | null {
  return req.headers.get("user-agent") || null
}
