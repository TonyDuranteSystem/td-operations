/**
 * Storage check for one company (staff only; dev job ad09ea91).
 *   GET                                       — what the CRM and the storage disagree about right now (reads only)
 *   POST { apply: [{ key, action }] }         — do the options staff ticked (each re-checked against the live state)
 *   POST { dismiss: "<finding key>" }         — "this is not an issue": stop showing it
 * Phase 1 only creates a person's storage, renames the company folder, moves a document a person ticked, and records answers.
 * It never ends anyone's access and never sends an email.
 */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  try {
    const { storageCheckFor } = await import("@/lib/crm-store/storage-check")
    return NextResponse.json(await storageCheckFor(params.id), { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not check the storage." }, { status: 500 })
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  const body = (await req.json().catch(() => ({}))) as { apply?: unknown; dismiss?: unknown }
  const { data: { user } } = await createClient().auth.getUser()
  try {
    if (typeof body.dismiss === "string" && body.dismiss) {
      const { dismissFinding, storageCheckFor } = await import("@/lib/crm-store/storage-check")
      await dismissFinding(params.id, body.dismiss, user?.id ?? null)
      return NextResponse.json({ ...(await storageCheckFor(params.id)), results: [] })
    }
    if (Array.isArray(body.apply)) {
      const requests = (body.apply as Array<{ key?: unknown; action?: unknown }>)
        .filter((r) => typeof r.key === "string" && typeof r.action === "string")
        .map((r) => ({ key: r.key as string, action: r.action as string }))
      if (requests.length === 0) return NextResponse.json({ error: "Nothing was ticked." }, { status: 400 })
      const { applyStorageCheck, storageCheckFor } = await import("@/lib/crm-store/storage-check")
      const results = await applyStorageCheck(params.id, requests, user?.id ?? null)
      return NextResponse.json({ ...(await storageCheckFor(params.id)), results })
    }
    return NextResponse.json({ error: "Tell me what to do (apply or dismiss)." }, { status: 400 })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "That could not be done." }, { status: 400 })
  }
}
