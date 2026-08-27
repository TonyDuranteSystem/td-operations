/**
 * POST /api/crm/admin-actions/reset-package-pick
 *
 * Staff-only escape hatch for multi-option offers (dev job 3c1bb5fa). Undoes a
 * client's locked package pick so they can choose again — the one recovery
 * path this feature deliberately ships with, since the public pick-lock is a
 * one-way action reachable by anyone holding the offer's link (a spouse or
 * co-founder opening a forwarded link, not just the intended decision-maker).
 *
 * Does NOT revert the price/state/company-type/renewal fields the lock wrote
 * onto the offer — the next lock overwrites them, and nothing treats them as
 * authoritative while the offer has packages and no lock timestamp.
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { canPerform } from "@/lib/permissions"
import { resetPackagePick } from "@/lib/offers/package-pick"

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!canPerform(user, "reset_package_pick")) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  }

  try {
    const body = await request.json().catch(() => ({}))
    const { offer_token, reason } = body as { offer_token?: string; reason?: string }

    if (!offer_token) {
      return NextResponse.json({ error: "offer_token is required" }, { status: 400 })
    }

    const result = await resetPackagePick({
      token: offer_token,
      actor: user?.email || "crm-admin",
      reason,
    })

    if (!result.success) {
      return NextResponse.json({ error: result.error || "Reset failed" }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 },
    )
  }
}
