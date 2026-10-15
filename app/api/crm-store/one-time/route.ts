/**
 * One-time customers (owners only; dev job ad09ea91).
 *   GET  — which Active One-Time companies have no storage yet, and whether each may get an empty one (reads only)
 *   POST — create the empty storages (idempotent; a company with a Drive folder or documents is skipped and listed)
 */
export const dynamic = "force-dynamic"
export const maxDuration = 120

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isOwnerOnly } from "@/lib/auth"

async function owner() {
  const { data: { user } } = await createClient().auth.getUser()
  return user && isOwnerOnly(user) ? user : null
}

export async function GET() {
  if (!(await owner())) return NextResponse.json({ error: "Owners only." }, { status: 403 })
  try {
    const { planOneTimeStorages } = await import("@/lib/crm-store/one-time")
    return NextResponse.json({ companies: await planOneTimeStorages() }, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not check the One-Time companies." }, { status: 500 })
  }
}

export async function POST() {
  if (!(await owner())) return NextResponse.json({ error: "Owners only." }, { status: 403 })
  try {
    const { createOneTimeStorages } = await import("@/lib/crm-store/one-time")
    return NextResponse.json(await createOneTimeStorages())
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The storages could not be created." }, { status: 500 })
  }
}
