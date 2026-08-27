import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { accessCodeError } from "@/lib/esign/access-guard"
import { lockPackagePick } from "@/lib/offers/package-pick"

export const dynamic = "force-dynamic"

/**
 * POST /api/offers/pick-package
 *
 * Locks a client's pick on a multi-option offer — the ONE write that turns a
 * multi-option offer into an ordinary, fully-resolved single-price offer (see
 * lib/offers/package-pick.ts for the full design). PUBLIC, token + access-code
 * only, no session — matches the protection level of the other public offer
 * routes, plus the constant-time/rate-limited code check the e-sign routes
 * already use, since this is a one-way, irreversible action a forwarded link
 * could otherwise trigger with no credential at all.
 *
 * Body: { token: string, code: string, package_key: string }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const { token, code, package_key: packageKey } = body as {
      token?: string
      code?: string
      package_key?: string
    }

    if (!token || !packageKey) {
      return NextResponse.json({ error: "Missing token or package_key" }, { status: 400 })
    }

    const { data: offer, error: offerErr } = await supabaseAdmin
      .from("offers")
      .select("token, access_code, status")
      .eq("token", token)
      .maybeSingle()

    if (offerErr || !offer) {
      return NextResponse.json({ error: "Offer not found" }, { status: 404 })
    }

    const codeErr = accessCodeError(req, {
      token,
      expected: offer.access_code || "",
      provided: code || "",
      isPreview: false,
    })
    if (codeErr) {
      return NextResponse.json({ error: codeErr.error }, { status: codeErr.status })
    }

    // Once an offer has moved past the pick stage there is nothing left to
    // pick — a stale tab retrying this call should get a clear refusal, not a
    // confusing attempt to relock an already-signed offer. `superseded` is
    // here too (found by adversarial review): a revised-away offer keeps its
    // packages and lock state intact (see lib/offers/revise-copy.ts), so
    // without this check a client holding the OLD link/email could still lock
    // and sign a dead version with different numbers than the live v2 draft.
    if (
      offer.status === "signed" ||
      offer.status === "completed" ||
      offer.status === "expired" ||
      offer.status === "superseded"
    ) {
      return NextResponse.json(
        { error: `This offer is already ${offer.status} — nothing to pick.` },
        { status: 409 },
      )
    }

    const result = await lockPackagePick({ token, packageKey, actor: "client" })

    if (!result.success) {
      const status =
        result.outcome === "not_found" ? 404 :
        result.outcome === "already_locked_different" ? 409 :
        result.outcome === "unknown_package" || result.outcome === "no_packages" ? 400 :
        500
      return NextResponse.json(
        { error: result.error || "Could not lock this pick.", outcome: result.outcome },
        { status },
      )
    }

    return NextResponse.json({ ok: true, outcome: result.outcome, selected_package_key: result.selected_package_key })
  } catch (err) {
    console.error("[pick-package] Error:", err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 },
    )
  }
}
