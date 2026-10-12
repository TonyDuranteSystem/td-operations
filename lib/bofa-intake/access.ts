/**
 * Bank of America intake — server-side access gate for the public one-time link.
 * Used by every /api/bank-application/[token]/* route. The claim is ATOMIC: the UPDATE only
 * succeeds while the row is still 'pending', so two browsers opening the link in the same
 * instant cannot both become the owner.
 */

import type { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { cookieName, decideAccess, hashSecret, newSecret, type LinkStatus } from "./lock"

export interface BofaLinkRow {
  id: string
  token: string
  label: string
  status: LinkStatus
  opener_hash: string | null
}

const COOKIE_MAX_AGE = 60 * 60 * 24 * 30

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- new table not in the generated DB types
const table = () => (supabaseAdmin as any).from("bofa_intake_requests")

/** Returns the row, null when the link does not exist, and THROWS on a database error (so a hiccup is never shown as "invalid link"). */
export async function loadLink(token: string): Promise<BofaLinkRow | null> {
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) return null
  const { data, error } = await table()
    .select("id, token, label, status, opener_hash")
    .eq("token", token)
    .maybeSingle()
  if (error) throw new Error(`bofa link lookup failed: ${error.message}`)
  return (data as BofaLinkRow | null) ?? null
}

export type GateResult =
  | { ok: true; row: BofaLinkRow; claimedSecret: string | null }
  | { ok: false; reason: "missing" | "used" | "pending" | "error" }

/** Decide whether this request may use the link; claim it if nobody has yet. */
export async function gateLink(req: NextRequest, token: string, mayClaim: boolean): Promise<GateResult> {
  let row: BofaLinkRow | null
  try {
    row = await loadLink(token)
  } catch (e) {
    console.error("[bank-application]", e)
    return { ok: false, reason: "error" }
  }
  if (!row) return { ok: false, reason: "missing" }
  const presented = req.cookies.get(cookieName(token))?.value ?? null
  const decision = decideAccess(row, presented)
  if (decision.access === "owner") return { ok: true, row, claimedSecret: null }
  if (decision.access === "used") return { ok: false, reason: "used" }

  // Not claimed yet and this request may not claim: the visitor must press "Start" first, so a
  // link-preview bot or an in-app browser that merely loads the page cannot burn the link.
  if (!mayClaim) return { ok: false, reason: row.status === "pending" ? "pending" : "used" }
  const secret = newSecret()
  const { data, error } = await table()
    .update({
      status: "opened",
      opener_hash: hashSecret(secret),
      opened_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .in("status", ["pending", "opened"])
    .is("opener_hash", null)
    .select("id")
    .maybeSingle()
  if (error || !data) return { ok: false, reason: "used" }
  return { ok: true, row: { ...row, status: "opened", opener_hash: hashSecret(secret) }, claimedSecret: secret }
}

export function attachOwnerCookie(res: NextResponse, token: string, secret: string): void {
  res.cookies.set(cookieName(token), secret, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  })
}
