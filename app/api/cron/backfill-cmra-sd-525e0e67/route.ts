/**
 * ONE-OFF backfill for dev job 525e0e67 (2026-08-30).
 *
 * 10 accounts have a real, signed CMRA lease but were never given the
 * internal "CMRA Mailing Address" service_delivery tracking record — the
 * lease-signed webhook's CMRA-advance step only ever ADVANCES an existing
 * SD, it never creates one, so any account whose SD was never seeded in the
 * first place (legacy/manual onboarding, pre-dating this webhook, etc.)
 * stays permanently flagged as "missing" on the account Issues panel.
 * Confirmed live: Nexo Agency LLC is the reference case that surfaced this.
 *
 * For every account below:
 *   1. Skip if a CMRA Mailing Address SD already exists (idempotent).
 *   2. createSD() — the same shared, validated-stage helper the live code
 *      uses — at stage "Lease Signed" (not stage 1: the lease really is
 *      already signed, and there's no evidence in the task history of any
 *      of these 10 progressing further than that, e.g. no Form 1583 task).
 *   3. Only for accounts whose business_mailing_address_id is unset, also
 *      link it to the TD address matching their own signed lease (same
 *      resolveTdMailingAddressForLease() helper the live webhook fix now
 *      uses) — never overwrite an address that's already set, since one of
 *      these 10 (E-commerce Empire New York LLC) is deliberately on a
 *      different TD building than the rest.
 *
 * Staff-only. Supports ?dry_run=true to preview without writing anything.
 * Safe to run more than once — step 1's existence check makes the SD
 * creation idempotent, and step 3 only ever touches a NULL address field.
 */
import { NextRequest, NextResponse } from "next/server"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { createSD } from "@/lib/operations/service-delivery"
import { linkAccountToLeaseMailingAddress } from "@/lib/operations/lease"

const ACCOUNT_IDS: { accountId: string; companyName: string }[] = [
  { accountId: "af514c76-d374-45f5-9c94-cc649fee31be", companyName: "Clearview Global LLC" },
  { accountId: "b84420a5-0780-4024-8b86-48af28fba1ac", companyName: "Clifton Pals LLC" },
  { accountId: "28703d94-8ef5-475f-93a5-648cccbc8ce6", companyName: "CORAGEM LLC" },
  { accountId: "169b9dcf-965e-41c8-9f87-ae49fa731a8b", companyName: "E-commerce Empire New York LLC" },
  { accountId: "1eb02f2c-fad3-4735-bc75-0edca3ca708a", companyName: "Infinity Commerce Group LLC" },
  { accountId: "827fb879-ac72-4945-b427-08b47f485cf6", companyName: "LUMA Beauty Global LLC" },
  { accountId: "502f86f1-f374-4a9d-b2e3-c3a4b36e8e9b", companyName: "NDB Company LLC" },
  { accountId: "1f7b255b-d204-44d4-a951-145aee11e273", companyName: "Nexo Agency LLC" },
  { accountId: "8fd57cb0-5901-4416-aa9a-5bcf3e160b09", companyName: "Nova Ecom Legacy LLC" },
  { accountId: "fb534d22-1b06-45ae-8cc6-6a3007f1a489", companyName: "Oh My Creatives LLC" },
]

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization")
  const hasCronSecret = !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`
  if (!hasCronSecret) {
    const denied = await requireStaffRoute()
    if (denied) return denied
  }

  const dryRun = req.nextUrl.searchParams.get("dry_run") === "true"
  const results: Array<Record<string, unknown>> = []

  for (const { accountId, companyName } of ACCOUNT_IDS) {
    const step: Record<string, unknown> = { account: companyName, account_id: accountId }
    try {
      const { data: existingSd } = await supabaseAdmin
        .from("service_deliveries")
        .select("id")
        .eq("account_id", accountId)
        .eq("service_type", "CMRA Mailing Address")
        .maybeSingle()

      if (existingSd) {
        step.action = "skipped_already_has_sd"
        results.push(step)
        continue
      }

      const { data: account } = await supabaseAdmin
        .from("accounts")
        .select("business_mailing_address_id")
        .eq("id", accountId)
        .single()

      const { data: lease } = await supabaseAdmin
        .from("lease_agreements")
        .select("premises_address")
        .eq("account_id", accountId)
        .eq("status", "signed")
        .order("signed_at", { ascending: false })
        .limit(1)
        .maybeSingle()

      let addressAction = "not_needed_already_set"
      if (!account?.business_mailing_address_id) {
        if (dryRun) {
          addressAction = "would_link_td_address"
        } else {
          const { linked, addressId } = await linkAccountToLeaseMailingAddress(accountId, lease?.premises_address ?? null)
          addressAction = linked ? `linked_to_${addressId}` : "skipped_no_matching_address"
        }
      }
      step.address_action = addressAction

      if (dryRun) {
        step.action = "would_create_sd_at_Lease_Signed"
        results.push(step)
        continue
      }

      const created = await createSD({
        service_type: "CMRA Mailing Address",
        account_id: accountId,
        target_stage: "Lease Signed",
        assigned_to: "Luca",
        notes: "Backfilled: account has a real signed CMRA lease but the internal tracking record was never created (dev job 525e0e67).",
      })
      step.action = "created_sd"
      step.sd_id = created.id
      step.stage = created.stage
      results.push(step)
    } catch (e) {
      step.error = e instanceof Error ? e.message : String(e)
      results.push(step)
    }
  }

  return NextResponse.json({ success: true, dry_run: dryRun, total: ACCOUNT_IDS.length, results })
}
