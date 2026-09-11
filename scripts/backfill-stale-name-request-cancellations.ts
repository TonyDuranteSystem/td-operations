/* eslint-disable no-console -- CLI backfill script reports progress via stdout. */
/**
 * One-time correction for the 2026-09-10 Lead Lift LLC incident (dev job
 * ebdb8e20): a client-facing "propose 3 new LLC names" request
 * (client_decision_requests, request_type='text_input', title='New LLC Names
 * Needed') can be left `status='pending'` forever once a sibling candidate
 * name on the same service delivery later succeeds (becomes available / sent
 * to client / accepted / filed) — nothing used to re-examine an already-created
 * request once the underlying "none of your names work" premise went stale.
 * The code fix (lib/operations/formation-name-checks.ts) stops NEW stale
 * requests from being created and cancels them going forward at the moment a
 * replacement name is sent to the client; this script sweeps up any that were
 * already created before that fix shipped.
 *
 * A request is "stale" here iff: it is still pending, AND
 * `allNamesDead(name_checks)` is now false for its service delivery — i.e.
 * some candidate has since become viable again. Driven off the SAME shared
 * predicate the app itself uses (lib/flows/name-checks.ts::allNamesDead), not
 * a hand-rolled SQL condition, so this can never diverge from what the live
 * code considers "stale".
 *
 * Idempotent and safe to re-run: cancelling an already-cancelled row is a
 * silent no-op (cancelPendingNewNamesRequests only ever touches rows still at
 * status='pending'). Never deletes anything — a soft status flip only.
 *
 * Default is DRY RUN — prints exactly what it would cancel without writing
 * anything. Apply for real:
 *   CONFIRM_PRODUCTION_BACKFILL=1 npx tsx scripts/backfill-stale-name-request-cancellations.ts --apply
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL from .env.local to determine the target —
 * prints which environment it's about to touch before doing anything, and
 * refuses to --apply against production without the confirmation env var.
 */

import { config } from "dotenv"
config({ path: ".env.local" })

import { supabaseAdmin } from "@/lib/supabase-admin"
import { allNamesDead, type NameCheck } from "@/lib/flows/name-checks"
import { cancelPendingNewNamesRequests } from "@/lib/operations/formation-name-checks"

const PROD_REF = "ydzipybqeebtpcvsbtvs"
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
const isProd = url.includes(PROD_REF)
const APPLY = process.argv.includes("--apply")

console.log(`Target: ${url || "(unset)"} — ${isProd ? "PRODUCTION" : "non-production"}`)
console.log(`Mode: ${APPLY ? "APPLY (will write)" : "DRY RUN (no writes)"}`)

if (APPLY && isProd && process.env.CONFIRM_PRODUCTION_BACKFILL !== "1") {
  console.error("")
  console.error("Refusing to apply against PRODUCTION without CONFIRM_PRODUCTION_BACKFILL=1.")
  console.error("Re-run as: CONFIRM_PRODUCTION_BACKFILL=1 npx tsx scripts/backfill-stale-name-request-cancellations.ts --apply")
  process.exit(1)
}

interface Finding {
  requestId: string
  serviceDeliveryId: string
  serviceName: string
  stage: string | null
  createdAt: string
  statuses: string[]
}

async function findStaleRequests(): Promise<Finding[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- client_decision_requests not in generated types
  const { data: requests, error } = await (supabaseAdmin as any)
    .from("client_decision_requests")
    .select("id, service_delivery_id, created_at")
    .eq("request_type", "text_input")
    .eq("title", "New LLC Names Needed")
    .eq("status", "pending")

  if (error) throw new Error(`decision-request scan failed: ${error.message}`)

  const findings: Finding[] = []
  for (const req of (requests ?? []) as Array<{ id: string; service_delivery_id: string; created_at: string }>) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- name_checks not in generated types
    const { data: sd, error: sdError } = await (supabaseAdmin as any)
      .from("service_deliveries")
      .select("id, service_name, stage, name_checks")
      .eq("id", req.service_delivery_id)
      .maybeSingle()
    if (sdError) throw new Error(`service_delivery lookup failed for ${req.service_delivery_id}: ${sdError.message}`)
    if (!sd) continue // orphaned request with no SD — outside this script's scope, never guessed at

    const checks = ((sd as Record<string, unknown>).name_checks ?? []) as NameCheck[]
    if (allNamesDead(checks)) continue // genuinely still waiting on the client — not stale

    findings.push({
      requestId: req.id,
      serviceDeliveryId: req.service_delivery_id,
      serviceName: (sd as Record<string, unknown>).service_name as string,
      stage: (sd as Record<string, unknown>).stage as string | null,
      createdAt: req.created_at,
      statuses: checks.map((c) => `${c.name} [${c.status}]`),
    })
  }
  return findings
}

async function main() {
  console.log("\nScanning for pending \"New LLC Names Needed\" requests superseded by a sibling name that already succeeded...\n")
  const findings = await findStaleRequests()

  console.log(`Found ${findings.length} stale request(s):\n`)
  for (const f of findings) {
    console.log(`  ${f.serviceName} — SD ${f.serviceDeliveryId}, now at stage "${f.stage}"`)
    console.log(`    request ${f.requestId}, created ${f.createdAt}`)
    console.log(`    current names: ${f.statuses.join(", ")}`)
  }

  if (findings.length === 0) {
    console.log("Nothing to do.")
    return
  }

  if (!APPLY) {
    console.log("\nDRY RUN — no writes performed. Re-run with --apply to cancel the requests listed above.")
    return
  }

  console.log(`\nCancelling ${findings.length} request(s)...\n`)
  for (const f of findings) {
    await cancelPendingNewNamesRequests(f.serviceDeliveryId)
    console.log(`  ✅ cancelled ${f.requestId} (${f.serviceName})`)
  }
  console.log("\nDone.")
}

main().catch((err) => {
  console.error("Backfill failed:", err instanceof Error ? err.message : err)
  process.exit(1)
})
