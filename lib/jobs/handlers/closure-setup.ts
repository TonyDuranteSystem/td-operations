/**
 * Job Handler: closure_setup
 *
 * Triggered by the portal Company Closure wizard (app/portal/wizard) when a
 * client submits closure data. Dev job fbbf4abe: before this handler existed,
 * 'closure' had no entry in JOB_TYPES (lib/portal/wizard-map.ts), so a portal
 * wizard closure submission saved its data and then triggered nothing else —
 * no Drive save, no staff task, no notification, no pipeline record — every
 * time, permanently. Confirmed live: one real client's closure sat untouched
 * for 86 days as a direct result.
 *
 * CONVERGENCE STRATEGY (same pattern already proven for ITIN,
 * lib/jobs/handlers/itin-wizard-setup.ts): this handler does NOT reimplement
 * the auto-chain. It delegates to `POST /api/closure-form-completed` — the
 * pipeline the OLDER, emailed-link closure flow already uses — by invoking
 * the route's POST function directly with a synthetic NextRequest. That route
 * already: checks for an existing active "Company Closure" service delivery
 * (scoped to account_id OR contact_id, correctly handling the account-less
 * case), creates one via createSD() if none exists (which itself reliably
 * creates the staff workflow task + chat note via dispatchWorkflowForSdCreated
 * — see lib/operations/service-delivery.ts), saves the client's documents to
 * Drive (both inline and via the durable archive-job backstop), and — on a
 * RESUBMISSION specifically — creates a plain staff task so a correction is
 * never silent. Converging both entry points onto one implementation means
 * the two small bugs already found and fixed there (a duplicate task on first
 * creation, a wrong field name blanking "Formation Year") are fixed for BOTH
 * paths at once, and there is only one place left to fix the next one.
 *
 * DATABASE-LEVEL DEDUP: a real duplicate-SD race (two concurrent submissions
 * both finding "no active SD" before either commits) is closed by a partial
 * unique index (scripts/migrations/20260826-1400-closure-sd-dedup-unique.sql),
 * not by this handler's own logic — the check-then-insert pattern below is
 * inherited from the existing route and is a reasonable fast path, but the
 * database is what actually prevents two rows from existing. createSD's
 * insert would fail on a genuine race; that surfaces as this job failing and
 * retrying, and the retry's own check-then-insert then finds the row the
 * other attempt created.
 *
 * PAYLOAD (built generically by wizard-submit/route.ts step 5, same shape
 * every submission-table wizard type already gets):
 *   {
 *     token: string          // matches the closure_submissions row's token
 *     submission_id: string  // UUID of the closure_submissions row
 *   }
 */

import { NextRequest } from "next/server"
import type { Job, JobResult } from "../queue"
import * as closureFormCompletedRoute from "@/app/api/closure-form-completed/route"

interface ClosureSetupPayload {
  token?: string
  submission_id?: string
  /** dev job fbbf4abe: the specific, already-verified pending record this
   *  submission belongs to. Forwarded through unchanged — wizard-submit
   *  already did the server-side verification; this handler never
   *  re-derives or re-checks it. */
  service_delivery_id?: string | null
  /** Content hash of the submitted data (lib/portal/wizard-job-dedupe.ts) —
   *  forwarded so the route can tell a genuine correction apart from an
   *  automatic retry of the exact same content. */
  dedupe_key?: string | null
}

interface ClosureRouteStep {
  step: string
  status: string
  detail?: string
}

interface ClosureRouteBody {
  ok?: boolean
  results?: ClosureRouteStep[]
  error?: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function normalizeStepStatus(status: string): "ok" | "error" | "skipped" {
  if (status === "ok" || status === "error" || status === "skipped") {
    return status
  }
  return "error"
}

export async function handleClosureSetup(job: Job): Promise<JobResult> {
  const p = job.payload as ClosureSetupPayload

  if (!p.token || !p.submission_id) {
    return {
      ok: false,
      steps: [
        {
          name: "validate_payload",
          status: "error",
          detail: `Missing required fields: ${!p.token ? "token " : ""}${!p.submission_id ? "submission_id" : ""}`.trim(),
          timestamp: nowIso(),
        },
      ],
      summary: "Closure setup failed: invalid payload",
    }
  }

  // Same synthetic-request approach as the ITIN wizard convergence: the route
  // reads its body via `await req.json()` and inspects no headers/cookies.
  const req = new NextRequest("http://internal/api/closure-form-completed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      submission_id: p.submission_id,
      token: p.token,
      service_delivery_id: p.service_delivery_id ?? null,
      dedupe_key: p.dedupe_key ?? null,
    }),
  })

  try {
    const res = await closureFormCompletedRoute.POST(req)
    const body = (await res.json()) as ClosureRouteBody
    const now = nowIso()

    const steps: JobResult["steps"] = (body.results ?? []).map((r) => ({
      name: r.step,
      status: normalizeStepStatus(r.status),
      detail: r.detail,
      timestamp: now,
    }))

    if (!res.ok || body.ok === false) {
      steps.push({
        name: "route_response",
        status: "error",
        detail: body.error ?? `HTTP ${res.status}`,
        timestamp: now,
      })
      return {
        ok: false,
        steps,
        summary: `Closure setup failed: ${body.error ?? `HTTP ${res.status}`}`,
      }
    }

    // The route itself always answers HTTP 200 / body.ok:true even when one of
    // its own internal steps failed (e.g. a transient Drive/Gmail error) — its
    // per-step results are the only place that failure shows up. Without this
    // check, a partially-failed chain would report itself as a clean success:
    // the worker only calls failJob() on `ok === false` (app/api/jobs/process/
    // route.ts), so an unset `ok` here means retry + Exception-Center
    // visibility never trigger, no matter how many steps actually errored.
    const okCount = steps.filter((s) => s.status === "ok").length
    const errCount = steps.filter((s) => s.status === "error").length
    return {
      ok: errCount === 0,
      steps,
      summary: `Closure auto-chain: ${okCount} ok, ${errCount} error${errCount === 1 ? "" : "s"}`,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      steps: [
        {
          name: "invoke_route",
          status: "error",
          detail: msg,
          timestamp: nowIso(),
        },
      ],
      summary: `Closure setup threw: ${msg}`,
    }
  }
}
