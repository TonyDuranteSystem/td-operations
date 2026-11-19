/**
 * Small server helpers shared by the CLIENT change (login-email-change-service.ts) and the STAFF change
 * (login-email-change-staff.ts) of a portal login email (dev job beb43385, steps 2 and 3): the audit row, and reading the contact's
 * name / language / emails. They live here, apart from the client service, so a CRM screen that only needs the staff change does not
 * drag the client flow (and the team-chat alert with its server-only import) into its bundle and its tests. SERVER-ONLY.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

// the untyped query builder: contacts is typed, but the select list is a plain string here
/* eslint-disable @typescript-eslint/no-explicit-any */
const contacts = () => (supabaseAdmin as unknown as { from: (t: string) => any }).from("contacts")

/** One row in action_log (never throws: a failed audit must not undo a change that already happened). */
export async function audit(action: string, who: string, auth: { authUserId: string; contactId: string | null }, summary: string, details: Record<string, unknown>) {
  try {
    await supabaseAdmin.from("action_log").insert({
      actor: who,
      action_type: action,
      table_name: "auth.users",
      record_id: auth.authUserId,
      contact_id: auth.contactId,
      summary,
      details: details as never,
    })
  } catch (e) {
    console.error("[login-email-change] audit log failed:", e)
  }
}

export interface ContactBits { first_name: string | null; full_name: string | null; language: string | null; email: string | null; alt_emails: string[] | null }

export async function readContact(contactId: string): Promise<ContactBits | null> {
  const { data } = await contacts().select("first_name, full_name, language, email, alt_emails").eq("id", contactId).limit(1)
  return (data && data[0]) || null
}

export const greetingName = (c: ContactBits | null) => (c?.first_name?.trim() || c?.full_name?.trim() || null)
