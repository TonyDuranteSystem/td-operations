/**
 * The shape of GET /api/flows/[id]/materialize-preflight, in one place, so the route that SENDS it and the
 * Articles-upload window that READS it cannot drift apart again.
 *
 * Why this exists (job f4f73e82, 2026-10-27): the route silently dropped `needs_state` / `needs_entity_type`
 * (regression from 480f5a5b8, 2026-09-11), so the window never showed its state / LLC-type pickers — staff saw only
 * "Pick the state manually to continue" and a locked Confirm button with nothing to click. Pure and client-safe
 * (type-only imports): no server code is pulled into the browser bundle.
 */
import type { FormationMaterializePreflightResult } from '@/lib/operations/formation-materialize'

export interface PreflightResponseBody {
  success: true
  applicable: true
  ok: boolean
  failure: FormationMaterializePreflightResult['failure'] | null
  error: string | null
  /** The state could not be worked out automatically — the window must show the state picker. */
  needs_state: boolean
  /** The LLC type could not be worked out automatically — the window must show the LLC-type picker. */
  needs_entity_type: boolean
  chosen_name: string | null
  state_code: string | null
  state_source: string | null
  entity_code: string | null
  entity_source: string | null
}

/** What the route answers for a Company Formation flow that has no company yet. */
export function buildPreflightResponseBody(
  pre: FormationMaterializePreflightResult,
  confirmedName: string | null,
): PreflightResponseBody {
  return {
    success: true,
    applicable: true,
    ok: pre.ok,
    failure: pre.failure ?? null,
    error: pre.error ?? null,
    needs_state: pre.needs_state === true,
    needs_entity_type: pre.needs_entity_type === true,
    chosen_name: pre.chosen_name ?? confirmedName ?? null,
    state_code: pre.state_code ?? null,
    state_source: pre.state_source ?? null,
    entity_code: pre.entity_code ?? null,
    entity_source: pre.entity_source ?? null,
  }
}

export interface PreflightPickers {
  /** Show the "Formation state" picker. */
  state: boolean
  /** Show the "LLC type" picker. */
  entityType: boolean
  /** A blocker staff cannot fix with a picker (e.g. no name marked as filed yet) — shown as text, Confirm stays locked. */
  blocked: string | null
}

/**
 * What the Articles-upload window should show for a preflight answer.
 *
 * The two `needs_*` flags are independent (a formation can need both). If an older or partial answer lacks them,
 * fall back on `failure`, so a state / LLC-type problem still gets its picker instead of a dead end. A refusal that
 * has nothing a picker can fix is returned as `blocked` text, and never silently swallowed.
 */
export function pickersFromPreflight(res: Partial<PreflightResponseBody> | null | undefined): PreflightPickers {
  const none: PreflightPickers = { state: false, entityType: false, blocked: null }
  if (!res || !res.applicable || res.ok !== false) return none

  let state = res.needs_state === true
  let entityType = res.needs_entity_type === true
  if (!state && !entityType) {
    if (res.failure === 'invalid_state') state = true
    else if (res.failure === 'missing_entity_type') entityType = true
  }
  if (state || entityType) return { state, entityType, blocked: null }

  return { state: false, entityType: false, blocked: res.error || 'The company cannot be created yet.' }
}
