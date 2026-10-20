/**
 * What a Company Change Name needs before it may move FORWARD (dev job bb64c417). Pure — the one
 * shared move (advanceServiceDelivery, lib/service-delivery.ts) calls it, so the workspace button,
 * the stepper and the CRM tools all get the same refusal (before this the only gate was a disabled
 * button in the staff panel: a stale tab or a direct call could reach "waiting for the state" with no
 * name filed, and the job then closed with the new name recorded nowhere).
 *
 *   - into "Client signs the name-change form" (or past it): a name the client confirmed (or one
 *     already filed) must exist;
 *   - into "Waiting for the state" (or past it): a name must be marked filed with the state.
 *
 * Moving BACK is never refused here (Go back must always work). A stage the catalog does not have
 * (the old five-stage catalog, before the 8-stage restructure) switches its gate off, so this can
 * ship before the catalog migration.
 */

import { CHANGE_NAME_STAGES } from '@/lib/flows/change-name-stages'
import type { NameCheck } from '@/lib/flows/name-checks'

export interface StageRef {
  stage_name: string
  stage_order: number
}

export const NEED_CONFIRMED_NAME =
  'The client has not confirmed a name yet. Send an available name to the client and wait for their confirmation first.'
export const NEED_FILED_NAME =
  'Mark the confirmed name as filed with the state first (use "Mark as Filed" in the names list).'

/** A refusal in plain words for a forward move, or null when the move is fine. */
export function changeNameAdvanceProblem(p: {
  checks: readonly NameCheck[] | null | undefined
  stages: readonly StageRef[]
  fromOrder: number
  targetOrder: number
}): string | null {
  if (p.targetOrder <= p.fromOrder) return null
  const orderOf = (name: string): number | undefined => p.stages.find((s) => s.stage_name === name)?.stage_order
  const list = Array.isArray(p.checks) ? p.checks : []
  const hasConfirmed = list.some((c) => c.status === 'accepted' || c.status === 'filed')
  const hasFiled = list.some((c) => c.status === 'filed')

  const signOrder = orderOf(CHANGE_NAME_STAGES.sign)
  if (signOrder !== undefined && p.targetOrder >= signOrder && !hasConfirmed) return NEED_CONFIRMED_NAME

  const waitOrder = orderOf(CHANGE_NAME_STAGES.wait)
  if (waitOrder !== undefined && p.targetOrder >= waitOrder && !hasFiled) return NEED_FILED_NAME

  return null
}
