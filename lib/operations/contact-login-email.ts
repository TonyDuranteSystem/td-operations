/**
 * The ONE place that moves a contact's email when the client changes their own portal LOGIN email (dev job beb43385, step 2).
 *
 * Why not updateContact(email): that helper runs the contact -> login sync (finds the login by contact id, would move a login with
 * no code, and sends a notice), and it drags the whole storage writer (image decoding) into the public "This wasn't me" page. Here the
 * login has ALREADY moved by its own id; this only makes the contact follow, and keeps the old address as an alternate (so inbox
 * matching still finds mail from it). The caller (lib/portal/login-email-change-service.ts) writes the audit row.
 * Lives in lib/operations/ because raw contacts writes belong here (lint rule P2.4).
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

export async function setContactEmailForLoginChange(params: {
  contactId: string
  email: string
  altEmails: string[]
}): Promise<{ error: string | null }> {
  const { error } = await supabaseAdmin
    .from("contacts")
    .update({ email: params.email, alt_emails: params.altEmails, updated_at: new Date().toISOString() })
    .eq("id", params.contactId)
  return { error: error ? error.message : null }
}
