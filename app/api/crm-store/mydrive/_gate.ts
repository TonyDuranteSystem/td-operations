import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isOwnerOnly } from "@/lib/auth"

/** Owners only — this reads the owner's OWN Google Drive. Returns the actor id, or the refusal. */
export async function mydriveGate(): Promise<{ actor: string } | NextResponse> {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 })
  if (!isOwnerOnly(user)) return NextResponse.json({ error: "Only an owner can copy from their own Google Drive." }, { status: 403 })
  return { actor: user.id }
}
