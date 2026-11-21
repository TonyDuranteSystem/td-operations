/**
 * Who already has this email? The ONE clash rule for changing a portal login email (dev job beb43385, steps 2 and 3).
 *
 * An email is "taken" when it is another login (any kind, marketing logins included), or the email / second email of
 * another contact. Used by the client change (lib/portal/login-email-change-service.ts, which only needs yes/no) and by
 * the staff change (lib/portal/login-email-change-staff.ts, which shows staff WHO has it; the client never sees that).
 * SERVER-ONLY. Fails closed: it throws when it cannot tell, and the caller refuses the change.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { listAllAuthUsers } from "@/lib/auth-admin-helpers"
import { normalizeEmail } from "@/lib/portal/login-email-change"

export type EmailOwner =
  | { kind: "login"; authUserId: string; contactId: string | null; role: string | null }
  | { kind: "contact"; contactId: string; column: "email" | "email_2" }

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

// the untyped query builder: `email_2` is checked by column name in a loop
/* eslint-disable @typescript-eslint/no-explicit-any */
const contacts = () => (supabaseAdmin as unknown as { from: (t: string) => any }).from("contacts")

/** The first owner of `email` other than `me` (the login and the contact being changed), or null when it is free. */
export async function findEmailOwner(email: string, me: { authUserId: string; contactId: string }): Promise<EmailOwner | null> {
  const key = normalizeEmail(email)
  const users = await listAllAuthUsers()
  const other = users.find((u) => normalizeEmail(u.email) === key && u.id !== me.authUserId)
  if (other) {
    const meta = (other.app_metadata ?? {}) as { contact_id?: string; role?: string }
    return { kind: "login", authUserId: other.id, contactId: meta.contact_id ?? null, role: meta.role ?? null }
  }
  for (const column of ["email", "email_2"] as const) {
    const { data, error } = await contacts().select("id").ilike(column, likeEscape(key)).neq("id", me.contactId).limit(1)
    if (error) throw new Error(`login-email-owner: contact check failed: ${error.message}`)
    if (data && data.length > 0) return { kind: "contact", contactId: data[0].id as string, column }
  }
  return null
}
