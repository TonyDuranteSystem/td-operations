import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isOwnerOnly } from "@/lib/auth"

/** Owners only — this reads the owner's OWN Google Drive. Returns the actor id, or the refusal. */
export async function mydriveGate(): Promise<{ actor: string; email: string } | NextResponse> {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 })
  if (!isOwnerOnly(user)) return NextResponse.json({ error: "Only an owner can copy from their own Google Drive." }, { status: 403 })
  return { actor: user.id, email: user.email ?? "" }
}

/** Audit trail: every browse of ANOTHER person's Drive and every copy is written down (who, whose Drive, what). Never blocks the work. */
export async function logDriveUse(g: { actor: string; email: string }, action: "drive_browse" | "drive_copy", account: string, detail: Record<string, unknown>): Promise<void> {
  try {
    const { supabaseAdmin } = await import("@/lib/supabase-admin")
    await supabaseAdmin.from("action_log").insert({ actor: g.email || g.actor, action_type: action, table_name: "google_drive", record_id: account, summary: `${g.email || g.actor} ${action === "drive_copy" ? "copied from" : "opened"} the Google Drive of ${account}`, details: detail as never })
  } catch (e) { console.error(`[mydrive] audit log failed: ${e instanceof Error ? e.message : e}`) }
}
