/**
 * What a Company Change Name needs before it may move FORWARD (dev job bb64c417). Pure — the one
 * shared move (advanceServiceDelivery, lib/service-delivery.ts) calls it, so the workspace button,
 * the stepper and the CRM tools all get the same refusal (before this the only gate was a disabled
 * button in the staff panel: a stale tab or a direct call could reach "waiting for the state" with no
 * name filed, and the job then closed with the new name recorded nowhere).
 *
 *   - into "Client signs the name-change form" (or past it): a name the client confirmed (or one
 *     already filed) must exist;
 *   - into "Waiting for the state" (or past it): a name must be marked filed with the state;
 *   - CROSSING "File the form with the state": the client must have SIGNED the name-change form (a completed e-sign
 *     envelope of this job) — before this the stepper could jump from the names straight to "waiting for the state"
 *     with no signed form and steps 3-4 shown as done (production QA, 2026-10-20);
 *   - CROSSING "Client updates the Operating Agreement": the new name must have been APPLIED (the company renamed
 *     and its folders moved) — before this the step's own button skipped Apply: the company kept its old name while
 *     the client was told "we updated our records" and asked to sign an Operating Agreement with the old name.
 *     "Crossing" = the move starts before that step and reaches or passes it, so a job that is already past it
 *     (an in-flight job from before this rule) is never trapped, and Go back always works.
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
export const NEED_SIGNED_FORM =
  'The client has not signed the name-change form yet. Send the form for signature and wait until the client has signed it.'
export const NEED_NAME_APPLIED =
  'The new name has not been applied yet. Use "Apply new name" on this step first — until then the company still has its old name.'

/** A refusal in plain words for a forward move, or null when the move is fine. */
export function changeNameAdvanceProblem(p: {
  checks: readonly NameCheck[] | null | undefined
  stages: readonly StageRef[]
  fromOrder: number
  targetOrder: number
  /** A completed e-sign envelope exists for this job. `undefined` = not looked up → that gate stays off. */
  hasSignedForm?: boolean
  /** This job's name change is applied and not undone. `undefined` = not looked up → that gate stays off. */
  nameApplied?: boolean
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

  const fileOrder = orderOf(CHANGE_NAME_STAGES.file)
  if (fileOrder !== undefined && p.fromOrder < fileOrder && p.targetOrder >= fileOrder && p.hasSignedForm === false) return NEED_SIGNED_FORM

  const oaOrder = orderOf(CHANGE_NAME_STAGES.oa)
  if (oaOrder !== undefined && p.fromOrder < oaOrder && p.targetOrder >= oaOrder && p.nameApplied === false) return NEED_NAME_APPLIED

  return null
}
