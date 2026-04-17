/**
 * P3.3 — Activation operation authority layer.
 *
 * Single-entry wrapper for the "activation flow" (post-payment orchestration
 * that turns a pending_activation into real SDs, portal user, invoices, and
 * downstream forms). The canonical implementation lives at
 * `app/api/workflows/activate-service/route.ts` (1124-line POST handler); this
 * module is the shared caller-side surface that both the manual Retry
 * Activation button (`retryActivation` server action) and any future MCP tool
 * or CRM button should go through — per plan §4 P3.3 L625 rule that every
 * CRM button and MCP tool performing the same operation routes through the
 * same `lib/operations/` function.
 *
 * Why the POST handler is NOT extracted here (Option A): extracting 1000+
 * lines of orchestration (lead→contact, ensure-account, createSDs, tier
 * upgrade, portal user, QB sync, form send, etc.) is a separate surgical
 * refactor with significant test surface. This module is Option A — a thin
 * shim that calls the existing endpoint via fetch. Option B (full extraction)
 * is a later P3.3 iteration once this shim is proven stable.
 *
 * Bug-magnet context (plan §16): commit `fbea91e` (2026-04-13) fixed the
 * enum-case bug `"paid"→"Paid"` that broke Abder Wakouz's activation. Commit
 * `78fc0a9` added the manual Retry Activation button on the lead page for
 * stuck-at-payment_confirmed cases. This module centralizes that retry path.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { INTERNAL_BASE_URL } from "@/lib/config"

// ─── Types ─────────────────────────────────────────────

export interface ActivateServiceParams {
  /** Primary key; pass this when you already have the pending_activation id. */
  pending_activation_id?: string
  /** Convenience for manual retry flows where only the offer token is known. */
  offer_token?: string
}

export type ActivateServiceOutcome =
  | "activated" // endpoint returned ok:true with data
  | "already_activated" // endpoint returned ok:true message:"Already activated" OR pre-check found activated_at
  | "not_ready" // pre-check: PA exists but status is not payment_confirmed
  | "not_found" // pre-check: PA does not exist
  | "error" // transport error, 4xx/5xx response, or invalid input

export interface ActivateServiceResult {
  success: boolean
  pending_activation_id?: string
  outcome: ActivateServiceOutcome
  /** Present when outcome is "activated". Echoes the route response body. */
  data?: {
    contract_type?: string
    mode?: "auto" | "supervised"
    steps?: unknown
    service_deliveries?: unknown
    prepared_steps?: number
  }
  error?: string
}

// ─── activateService ───────────────────────────────────

/**
 * Orchestrate the post-payment activation flow for a single pending_activation.
 *
 * Pre-checks (avoid wasting a fetch when the gate will fail):
 *   - Resolve pending_activation_id (from offer_token if needed).
 *   - Return `not_found` when no row matches.
 *   - Return `already_activated` when activated_at is set.
 *   - Return `not_ready` when status !== "payment_confirmed".
 *
 * Then calls POST /api/workflows/activate-service with Bearer
 * `API_SECRET_TOKEN`. Returns a structured result. Does NOT call
 * `revalidatePath` (that's server-action-only territory — the caller
 * decorates as needed).
 */
export async function activateService(
  params: ActivateServiceParams,
): Promise<ActivateServiceResult> {
  // ─── Input validation ────────────────────────────────
  if (!params.pending_activation_id && !params.offer_token) {
    return {
      success: false,
      outcome: "error",
      error: "Must provide pending_activation_id or offer_token",
    }
  }

  // ─── Resolve pending_activation_id ───────────────────
  let paId = params.pending_activation_id
  if (!paId && params.offer_token) {
    const { data: pa, error } = await supabaseAdmin
      .from("pending_activations")
      .select("id, status, activated_at")
      .eq("offer_token", params.offer_token)
      .single()

    if (error || !pa) {
      return {
        success: false,
        outcome: "not_found",
        error: `No pending_activation for offer_token "${params.offer_token}"`,
      }
    }

    if (pa.activated_at) {
      return {
        success: true,
        pending_activation_id: pa.id,
        outcome: "already_activated",
      }
    }
    if (pa.status !== "payment_confirmed") {
      return {
        success: false,
        pending_activation_id: pa.id,
        outcome: "not_ready",
        error: `Status is "${pa.status}" — must be payment_confirmed`,
      }
    }
    paId = pa.id
  } else if (paId) {
    // pending_activation_id was passed directly — verify gate before calling endpoint.
    const { data: pa, error } = await supabaseAdmin
      .from("pending_activations")
      .select("id, status, activated_at")
      .eq("id", paId)
      .single()

    if (error || !pa) {
      return {
        success: false,
        outcome: "not_found",
        error: `No pending_activation with id "${paId}"`,
      }
    }

    if (pa.activated_at) {
      return {
        success: true,
        pending_activation_id: pa.id,
        outcome: "already_activated",
      }
    }
    if (pa.status !== "payment_confirmed") {
      return {
        success: false,
        pending_activation_id: pa.id,
        outcome: "not_ready",
        error: `Status is "${pa.status}" — must be payment_confirmed`,
      }
    }
  }

  // ─── Call the endpoint ───────────────────────────────
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || INTERNAL_BASE_URL
  const secret = process.env.API_SECRET_TOKEN

  if (!secret) {
    return {
      success: false,
      pending_activation_id: paId,
      outcome: "error",
      error: "API_SECRET_TOKEN not configured",
    }
  }

  let res: Response
  try {
    res = await fetch(`${baseUrl}/api/workflows/activate-service`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({ pending_activation_id: paId }),
    })
  } catch (err) {
    return {
      success: false,
      pending_activation_id: paId,
      outcome: "error",
      error: err instanceof Error ? err.message : "Fetch failed",
    }
  }

  let body: Record<string, unknown>
  try {
    body = await res.json()
  } catch {
    return {
      success: false,
      pending_activation_id: paId,
      outcome: "error",
      error: `Non-JSON response (status ${res.status})`,
    }
  }

  if (!res.ok) {
    return {
      success: false,
      pending_activation_id: paId,
      outcome: "error",
      error:
        typeof body.error === "string"
          ? body.error
          : `Activation failed (${res.status})`,
    }
  }

  // 200 OK with "Already activated" message (route line 164).
  if (body.message === "Already activated") {
    return {
      success: true,
      pending_activation_id: paId,
      outcome: "already_activated",
    }
  }

  // Normal success (route line 1111): {ok, contract_type, mode, steps, ...}
  return {
    success: true,
    pending_activation_id: paId,
    outcome: "activated",
    data: {
      contract_type: body.contract_type as string | undefined,
      mode: body.mode as "auto" | "supervised" | undefined,
      steps: body.steps,
      service_deliveries: body.service_deliveries,
      prepared_steps:
        typeof body.prepared_steps === "number"
          ? body.prepared_steps
          : undefined,
    },
  }
}
