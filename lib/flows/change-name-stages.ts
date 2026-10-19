/**
 * The stages of the Company Change Name service (dev job bb64c417), by their internal names — ONE
 * list that the client-visible-document allowlist, the advance gates and the catalog migration all
 * share, so a rename can never silently disconnect one of them (stage names are matched EXACTLY by
 * layouts, workflow buttons, advance targets and the notices; see lib/services/protected-stage-names.ts).
 * The 8th stage is bookkeeping: the only "done" step, so the job closes once the client's new
 * Operating Agreement is in — it does not appear to the client as a step.
 *
 * Pure and client-safe.
 */
export const CHANGE_NAME_STAGES = {
  /** 1 — the client sends up to three names (his turn). */
  collect: 'Collect three company names',
  /** 2 — staff checks the names with the state; the client confirms ONE available name. */
  check: 'Check names and client confirms',
  /** 3 — the client e-signs the state's name-change form. */
  sign: 'Client signs the name-change form',
  /** 4 — staff files the signed form with the state. */
  file: 'File the form with the state',
  /** 5 — waiting for the state's answer (an outside office); the stamped document comes in here. */
  wait: 'Waiting for the state',
  /** 6 — staff applies the new name to our records (account + storage). */
  records: 'Update our records',
  /** 7 — the client generates the new version of the Operating Agreement in the portal. */
  oa: 'Client updates the Operating Agreement',
  /** 8 — closed (the only done step). */
  done: 'Completed',
} as const

/** The stages in order (stage_order 1..8). */
export const CHANGE_NAME_STAGE_ORDER: readonly string[] = [
  CHANGE_NAME_STAGES.collect,
  CHANGE_NAME_STAGES.check,
  CHANGE_NAME_STAGES.sign,
  CHANGE_NAME_STAGES.file,
  CHANGE_NAME_STAGES.wait,
  CHANGE_NAME_STAGES.records,
  CHANGE_NAME_STAGES.oa,
  CHANGE_NAME_STAGES.done,
]
