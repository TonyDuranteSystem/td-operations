/**
 * syncLeadEmailToOfferArtifacts — propagate a corrected lead email.
 *
 * The same client email is stored in four disconnected places: the lead, the
 * offer (offers.client_email), the contact (contacts.email), and the portal
 * login (auth.users.email). When a typo is fixed on the lead, the other three
 * are left pointing at the wrong address — so a re-send goes to the old inbox
 * and publishing again spawns a duplicate portal account. This helper carries
 * the correction across to the offer + portal artifacts that were created from
 * the old email.
 *
 * Best-effort and non-fatal: a failure in any one step is recorded in
 * `skipped` and does not stop the others. The lead row itself is updated by
 * the caller (update-lead-field route).
 *
 * Mirrors updateContactField's discipline (app/(dashboard)/accounts/actions.ts):
 * change the portal login first, refuse to clobber a different record that
 * already owns the new email.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { findAuthUserByEmail } from "@/lib/auth-admin-helpers"

// Offers in these states are historical and must not be retargeted — their
// email is part of a signed/superseded record.
const FINAL_OFFER_STATUSES = ["signed", "completed", "superseded"]

export interface SyncLeadEmailResult {
  offersUpdated: number
  contactUpdated: boolean
  authUserUpdated: boolean
  skipped: string[]
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function syncLeadEmailToOfferArtifacts(params: {
  leadId: string
  oldEmail: string | null
  newEmail: string
}): Promise<SyncLeadEmailResult> {
  const result: SyncLeadEmailResult = {
    offersUpdated: 0,
    contactUpdated: false,
    authUserUpdated: false,
    skipped: [],
  }

  const newEmail = params.newEmail.trim()
  const oldEmail = params.oldEmail?.trim() || null

  if (!newEmail) {
    result.skipped.push("new email is empty")
    return result
  }
  if (oldEmail && oldEmail.toLowerCase() === newEmail.toLowerCase()) {
    result.skipped.push("email unchanged")
    return result
  }

  // (a) Linked, non-final offers → point them at the corrected address.
  try {
    const { data: offers } = await supabaseAdmin
      .from("offers")
      .select("token, status")
      .eq("lead_id", params.leadId)
    const updatable = (offers ?? []).filter(
      (o) => !FINAL_OFFER_STATUSES.includes(o.status),
    )
    for (const o of updatable) {
      const { error } = await supabaseAdmin
        .from("offers")
        .update({ client_email: newEmail, updated_at: new Date().toISOString() })
        .eq("token", o.token)
      if (error) result.skipped.push(`offer ${o.token}: ${error.message}`)
      else result.offersUpdated += 1
    }
  } catch (err) {
    result.skipped.push(`offers: ${describe(err)}`)
  }

  // The contact + portal login were keyed off the OLD email. Without it we
  // cannot find them, so the offer retarget above is all we can do.
  if (!oldEmail) {
    result.skipped.push("no prior email — contact/portal not migrated")
    return result
  }

  // (b) Portal login — change auth.users first, refusing to overwrite a
  // different login that already owns the new email.
  try {
    const authUserOld = await findAuthUserByEmail(oldEmail)
    const authUserNew = await findAuthUserByEmail(newEmail)
    if (authUserNew && (!authUserOld || authUserNew.id !== authUserOld.id)) {
      result.skipped.push("portal: a different login already uses the new email")
    } else if (authUserOld) {
      const { error: authErr } = await supabaseAdmin.auth.admin.updateUserById(
        authUserOld.id,
        { email: newEmail },
      )
      if (authErr) result.skipped.push(`portal: ${authErr.message}`)
      else result.authUserUpdated = true
    }
  } catch (err) {
    result.skipped.push(`portal: ${describe(err)}`)
  }

  // (c) Contact record — same no-clobber rule.
  try {
    const { data: contactNew } = await supabaseAdmin
      .from("contacts")
      .select("id")
      .eq("email", newEmail)
      .limit(1)
      .maybeSingle()
    if (contactNew) {
      result.skipped.push("contact: a different contact already uses the new email")
    } else {
      const { data: contactOld } = await supabaseAdmin
        .from("contacts")
        .select("id")
        .eq("email", oldEmail)
        .limit(1)
        .maybeSingle()
      if (contactOld) {
        // eslint-disable-next-line no-restricted-syntax -- email-correction sync; contact write helper not yet extracted (dev_task 7ebb1e0c)
        const { error } = await supabaseAdmin
          .from("contacts")
          .update({ email: newEmail })
          .eq("id", contactOld.id)
        if (error) result.skipped.push(`contact: ${error.message}`)
        else result.contactUpdated = true
      }
    }
  } catch (err) {
    result.skipped.push(`contact: ${describe(err)}`)
  }

  return result
}
