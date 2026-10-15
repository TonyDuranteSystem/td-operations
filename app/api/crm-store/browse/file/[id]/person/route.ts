/**
 * "Belongs to another person" (new CRM store, staff only) — a personal document filed under the wrong person.
 *   GET  /api/crm-store/browse/file/<id>/person            — the people it can go to (people of the same companies)
 *   POST /api/crm-store/browse/file/<id>/person { contactId } — re-home the file into that person's storage; its CRM record follows
 */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { denyUnlessStoreStaff, denyUnlessStorePilotEnv, denyUnlessAreaAccess } from "../../../_auth"

async function guard(id: string) {
  return (await denyUnlessStoreStaff()) ?? (await denyUnlessStorePilotEnv({ study: true, fileId: id })) ?? (await denyUnlessAreaAccess({ fileId: id }))
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await guard(params.id)
  if (denied) return denied
  try {
    const { peopleForFile } = await import("@/lib/crm-store/change-person")
    return NextResponse.json({ people: await peopleForFile(params.id) }, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read the people." }, { status: 400 })
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await guard(params.id)
  if (denied) return denied
  const body = (await req.json().catch(() => ({}))) as { contactId?: unknown }
  if (typeof body.contactId !== "string" || !body.contactId) return NextResponse.json({ error: "Choose a person." }, { status: 400 })
  const { data: { user } } = await createClient().auth.getUser()
  try {
    const { changeFilePerson } = await import("@/lib/crm-store/change-person")
    return NextResponse.json(await changeFilePerson(params.id, body.contactId, user?.id ?? null))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The file could not be moved." }, { status: 400 })
  }
}
