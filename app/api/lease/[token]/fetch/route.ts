/**
 * GET /api/lease/[token]/fetch?code=<accessCode>[&portal=true][&preview=td]
 * Email-gate answer arrives in the `x-lease-email` HEADER (never the query string —
 * a query param would put the client's address into every access log).
 *
 * The ONLY way a public lease page may obtain lease data. Replaces a browser-side
 * `select('*')` on `lease_agreements` with the anon key + a CLIENT-SIDE access-code
 * comparison (i.e. after the whole row, including access_code / tenant_ein /
 * tenant_email, had already been delivered). See lib/lease/public-view.ts.
 *
 * Gates, all server-side, all fail-closed:
 *   1. access code — constant-time, rate-limited (shared lib/esign/access-guard).
 *   2. admin preview — requires a REAL staff session, never the bare query flag
 *      (lib/auth/staff-preview). Preview + portal skip ONLY the email gate.
 *   3. email gate — the tenant address is compared here and never sent to the browser.
 * View tracking moved here too (was an anon UPDATE from the page).
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { accessCodeError } from "@/lib/esign/access-guard"
import { isStaffPreview } from "@/lib/auth/staff-preview"
import { LEASE_SELECT, toPublicLease, assertNoLeaseSecrets, leaseEmailMatches } from "@/lib/lease/public-view"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const url = new URL(req.url)
  const code = url.searchParams.get("code") || ""
  const email = req.headers.get("x-lease-email")
  const isPreview = await isStaffPreview(url.searchParams.get("preview") === "td")

  const { data: lease } = await db
    .from("lease_agreements")
    .select(LEASE_SELECT)
    .eq("token", token)
    .maybeSingle()

  if (!lease) {
    return NextResponse.json({ error: "Lease not found." }, { status: 404 })
  }

  const codeErr = accessCodeError(req, { token, expected: lease.access_code, provided: code, isPreview })
  if (codeErr) return NextResponse.json({ error: codeErr.error }, { status: codeErr.status })

  // Email gate. Staff preview and the embedded portal iframe skip ONLY the email
  // step — the access code was already required above and is the real credential.
  const portalMode = url.searchParams.get("portal") === "true"
  const previewFlag = url.searchParams.get("preview") === "td"
  const gateAddress = isPreview || portalMode || previewFlag ? null : lease.tenant_email
  if (gateAddress && !leaseEmailMatches(gateAddress, email)) {
    // No lease data — an unverified caller receives nothing, not even the address.
    return NextResponse.json({ requiresEmail: true, companyName: lease.tenant_company })
  }

  // View tracking — server-side, best effort, never blocks the read. Skipped for
  // any preview, and once signed.
  if (!isPreview && !previewFlag && !lease.signed_at) {
    try {
      await db
        .from("lease_agreements")
        .update({
          view_count: (lease.view_count ?? 0) + 1,
          viewed_at: new Date().toISOString(),
          status: ["draft", "sent"].includes(lease.status) ? "viewed" : lease.status,
        })
        .eq("id", lease.id)
    } catch {
      // Tracking is not worth failing a signing session over.
    }
  }

  const payload = { requiresEmail: false, isPreview, lease: toPublicLease(lease) }
  assertNoLeaseSecrets(payload)
  return NextResponse.json(payload)
}
