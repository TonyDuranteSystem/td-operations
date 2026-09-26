import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isStoreStaffUser } from "@/lib/crm-store/access"

/** Staff allow-list (admin / team) for the read-only new-store browser. null = allowed. */
export async function denyUnlessStoreStaff(): Promise<NextResponse | null> {
  const { data: { user } } = await createClient().auth.getUser()
  if (!isStoreStaffUser(user)) return NextResponse.json({ error: "Staff only" }, { status: 403 })
  return null
}

/** For the routes that CHANGE the new store (upload, show/hide): only where the pilot may run. */
export async function denyUnlessStorePilotEnv(): Promise<NextResponse | null> {
  const { pilotEnvironmentAllowed } = await import("@/lib/crm-store/formation-pilot")
  if (!pilotEnvironmentAllowed()) return NextResponse.json({ error: "The new storage is not switched on here." }, { status: 403 })
  return null
}
