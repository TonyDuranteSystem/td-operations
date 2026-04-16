/**
 * P1.6 — Portal operation authority layer
 *
 * Single-entry wrappers for portal-user creation and tier management.
 * Thin shims over `lib/portal/auto-create.ts` (the canonical implementation)
 * plus a new `reconcileTier` helper that forces contact, account, and
 * auth.users.app_metadata to match the source of truth.
 *
 * Why `reconcileTier` is new here:
 * dev_task 6d2a2be1 documents a recurring class of bug — "CRM buttons don't
 * replicate automated flow": contacts.portal_tier and accounts.portal_tier
 * drift out of sync because admin-action code paths update one without the
 * other.  `upgradePortalTier` only upgrades (never downgrades), which is
 * correct for user-facing flows but leaves drift uncorrected.  `reconcileTier`
 * is the repair path — it enforces equality across all three sources using
 * contacts.portal_tier as the authoritative value.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { findAuthUserByEmail } from "@/lib/auth-admin-helpers"
import {
  autoCreatePortalUser,
  sendPortalWelcomeEmail,
  upgradePortalTier,
} from "@/lib/portal/auto-create"
import type { PortalTier } from "@/lib/portal/tier-config"

// ─── Re-exports (single import surface for P1.6 callers) ──

/**
 * Create (or idempotently fetch) a portal auth user for a contact/account.
 * Returns `alreadyExists=true` when the user is already present.
 *
 * Wrapper over `autoCreatePortalUser` — same semantics, same result shape.
 */
export const createPortalUser = autoCreatePortalUser

/**
 * Upgrade an account's portal tier (and all linked contacts + auth users).
 * Only upgrades, never downgrades.  Wrapper over `upgradePortalTier`.
 */
export const upgradeTier = upgradePortalTier

/**
 * Send the portal welcome email with temp password.  Wrapper over
 * `sendPortalWelcomeEmail`.
 */
export const sendWelcomeEmail = sendPortalWelcomeEmail

// ─── reconcileTier (new in P1.6) ───────────────────────

export interface ReconcileTierParams {
  contact_id: string
  /** Optional override — if omitted, uses contacts.portal_tier as truth. */
  target_tier?: PortalTier
}

export interface ReconcileTierResult {
  success: boolean
  contact_id: string
  resolved_tier: PortalTier | null
  changed: {
    contact: boolean
    accounts: string[]
    auth_user: boolean
  }
  error?: string
}

/**
 * Force contact + linked accounts + auth.users.app_metadata to all match
 * the same portal_tier value.  Repair-only operation — does not gate on
 * upgrade-vs-downgrade semantics (see `upgradeTier` for that).
 *
 * Source of truth: contacts.portal_tier (per confirmed business rule in
 * session-context "CONFIRMED BUSINESS RULES").  If `target_tier` is passed,
 * it overrides — useful when an admin needs to force a specific value
 * (e.g. after a cancellation flipping everything to 'inactive').
 */
export async function reconcileTier(
  params: ReconcileTierParams,
): Promise<ReconcileTierResult> {
  const result: ReconcileTierResult = {
    success: false,
    contact_id: params.contact_id,
    resolved_tier: null,
    changed: { contact: false, accounts: [], auth_user: false },
  }

  const { data: contact, error: cErr } = await supabaseAdmin
    .from("contacts")
    .select("id, email, portal_tier")
    .eq("id", params.contact_id)
    .single()

  if (cErr || !contact) {
    result.error = `Contact not found: ${cErr?.message || "unknown"}`
    return result
  }

  const tier = (params.target_tier ||
    (contact.portal_tier as PortalTier) ||
    null) as PortalTier | null

  if (!tier) {
    result.error = "No tier to reconcile (contacts.portal_tier is null and no target_tier provided)"
    return result
  }

  result.resolved_tier = tier

  // 1. Contact — only write if target_tier overrode and differs
  if (params.target_tier && params.target_tier !== contact.portal_tier) {
    await supabaseAdmin
      .from("contacts")
      .update({ portal_tier: params.target_tier })
      .eq("id", contact.id)
    result.changed.contact = true
  }

  // 2. Linked accounts
  const { data: links } = await supabaseAdmin
    .from("account_contacts")
    .select("account_id")
    .eq("contact_id", contact.id)

  for (const link of links ?? []) {
    if (!link.account_id) continue
    const { data: acct } = await supabaseAdmin
      .from("accounts")
      .select("id, portal_tier")
      .eq("id", link.account_id)
      .single()
    if (acct && acct.portal_tier !== tier) {
      await supabaseAdmin
        .from("accounts")
        .update({ portal_tier: tier, updated_at: new Date().toISOString() })
        .eq("id", acct.id)
      result.changed.accounts.push(acct.id)
    }
  }

  // 3. Auth user (by email) — paginated via findAuthUserByEmail (P1.9)
  if (contact.email) {
    const authUser = await findAuthUserByEmail(contact.email)
    if (authUser) {
      const currentTier =
        (authUser.app_metadata?.portal_tier as string | undefined) ?? null
      if (currentTier !== tier) {
        await supabaseAdmin.auth.admin.updateUserById(authUser.id, {
          app_metadata: { ...authUser.app_metadata, portal_tier: tier },
        })
        result.changed.auth_user = true
      }
    }
  }

  result.success = true
  return result
}
