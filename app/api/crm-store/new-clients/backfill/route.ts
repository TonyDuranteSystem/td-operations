/**
 * Bring ONE new client who signed/paid before the new-clients switch into the new storage (owners only; dev job ad09ea91).
 *   GET  ?contact=<id>   — DRY RUN: what would happen (reads only)
 *   POST { contactId }   — do it (idempotent): the signed contract → the person's storage; an open formation case → its storage
 * Needs STORE_NEW_CLIENTS=1 in this environment.
 */
export const dynamic = "force-dynamic"
export const maxDuration = 120

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isOwnerOnly } from "@/lib/auth"

async function owner() {
  const { data: { user } } = await createClient().auth.getUser()
  return user && isOwnerOnly(user) ? user : null
}

export async function GET(req: NextRequest) {
  if (!(await owner())) return NextResponse.json({ error: "Owners only." }, { status: 403 })
  const contactId = req.nextUrl.searchParams.get("contact")
  if (!contactId) return NextResponse.json({ error: "contact is required" }, { status: 400 })
  try {
    const { planNewClientBackfill } = await import("@/lib/crm-store/new-client-backfill")
    return NextResponse.json(await planNewClientBackfill(contactId), { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not check this client." }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  if (!(await owner())) return NextResponse.json({ error: "Owners only." }, { status: 403 })
  const body = (await req.json().catch(() => ({}))) as { contactId?: string }
  if (!body.contactId) return NextResponse.json({ error: "contactId is required" }, { status: 400 })
  try {
    const { runNewClientBackfill, BackfillRefused } = await import("@/lib/crm-store/new-client-backfill")
    try {
      return NextResponse.json(await runNewClientBackfill(body.contactId))
    } catch (e) {
      if (e instanceof BackfillRefused) return NextResponse.json({ error: e.message }, { status: 409 })
      throw e
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The backfill failed." }, { status: 500 })
  }
}
