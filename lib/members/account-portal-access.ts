/**
 * Does ANYONE tied to an account have a working portal login — not just one
 * specific "primary" contact.
 *
 * Why this exists (2026-08-28, dev job bb48eba1, child 4e0a74af): the
 * client-diagnostics "Portal auth user" check tested only the resolved
 * primary contact's own email. For a Multi-Member LLC that is the wrong
 * question — portal access is granted per person, and the flagged Primary
 * specifically not having logged in yet does not mean the company can't get
 * in. Confirmed live on THW Global LLC: two of its three members have
 * active logins (one signed in the same day this was found), but the
 * flagged Primary has never made one himself, and the check reported a
 * false "No portal login" error.
 *
 * Candidates are the UNION of the Members panel (`members.contact_id`) and
 * the older `account_contacts` list, not either alone:
 *  - Real accounts exist with a `members` row whose contact isn't linked in
 *    `account_contacts` at all.
 *  - Real accounts (Oh My Creatives LLC, Conversion Monsters LLC) exist
 *    where the person's actual working login sits on a SEPARATE, duplicate
 *    contact record that exists only in `account_contacts`, never in
 *    `members` — checking `members` alone would still miss it.
 *
 * This is evidence, not proof: nothing in the system revokes a login or
 * unlinks `account_contacts` when a member leaves (the roster-resubmit path
 * only rewrites `members`), so a departed member's stale login could in
 * theory still satisfy this check. There is no reliable way to tell that
 * apart from a legitimate duplicate contact record for someone still there
 * (both are just "a contact_id present in account_contacts but not
 * members"), so instead of an unreliable filter, the caller is handed WHO
 * satisfied the check — a human can eyeball whether it's someone who should
 * still be there.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { findAuthUsersByEmails } from "@/lib/auth-admin-helpers"

export interface AccountPortalAccess {
  /** The contact whose login satisfied the check, if any. Null means
   *  nobody linked to this account has a working portal login. */
  loginContact: { name: string | null; email: string } | null
}

export async function resolveAccountPortalAccess(
  accountId: string,
): Promise<AccountPortalAccess> {
  const [membersRes, acRes] = await Promise.all([
    supabaseAdmin.from("members").select("contact_id").eq("account_id", accountId),
    supabaseAdmin.from("account_contacts").select("contact_id").eq("account_id", accountId),
  ])

  const candidateIds = Array.from(new Set([
    ...(membersRes.data || []).map((m: { contact_id: string | null }) => m.contact_id),
    ...(acRes.data || []).map((a: { contact_id: string | null }) => a.contact_id),
  ].filter((id): id is string => !!id)))

  if (candidateIds.length === 0) return { loginContact: null }

  const { data: candidateContacts } = await supabaseAdmin
    .from("contacts")
    .select("full_name, email")
    .in("id", candidateIds)

  const emails = (candidateContacts || [])
    .map((c: { email: string | null }) => c.email)
    .filter((e): e is string => !!e)

  if (emails.length === 0) return { loginContact: null }

  const authMap = await findAuthUsersByEmails(emails)
  const withLogin = (candidateContacts || []).find(
    (c: { email: string | null }) => c.email && authMap.has(c.email.toLowerCase().trim()),
  )

  return {
    loginContact: withLogin
      ? { name: (withLogin.full_name as string | null) ?? null, email: withLogin.email as string }
      : null,
  }
}
