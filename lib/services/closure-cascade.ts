/**
 * Company Closure — the follow-up to-dos left behind when a company is closed.
 *
 * A closure job has a step called "Wrap-up" (ours) in front of the finishing step "Closing". Wrap-up carries the three
 * chores that go with closing a company: cancel the Registered Agent on Harbor, cancel the CMRA mailing address / lease,
 * and stop the yearly renewals. Pressing "Wrap-up done" moves the job to "Closing", which (lib/service-delivery.ts,
 * "14. Company Closure") closes the company and marks every open to-do of the account Done in one sweep.
 *
 * That sweep must never swallow a chore nobody did. So just before it runs, the job's own to-dos are read, and every chore
 * that is NOT recorded Done comes back as a "[CLOSURE]" follow-up to-do. This also covers a job that skipped Wrap-up
 * altogether (moved straight to Closing, or advanced with the step to-dos switched off): it has no chore to-dos, so all
 * three come back.
 * The QuickBooks to-do ("cancel QB recurring invoices") and the "email the client — closure complete" to-do are GONE (Company
 * Closure Part C, dev job a6bbea09): QuickBooks is decommissioned, and Antonio decided the client gets no closing e-mail
 * (2026-11-05). What is left is the Registered Agent chore on Harbor (always — it is the one thing nothing else tracks), plus the
 * mailing-address lease chore ONLY when the company really has a lease (`hasLease`), so a closure no longer leaves a lease billing.
 * The Wrap-up step itself is still dormant until its migration runs.
 *
 * Pure — no database. The titles below are the to-do titles of the Wrap-up step (pipeline_stages.auto_tasks, set by
 * scripts/migrations/20261015-1200-closure-wrapup-step.sql; tests/unit/closure-cascade.test.ts keeps the two in step).
 */

import type { Database } from "@/lib/database.types"

type TaskCategory = Database["public"]["Enums"]["task_category"]

/** The step the chores live on. Pinned in lib/services/protected-stage-names.ts: the closure workflow matches it by name. */
export const WRAP_UP_STAGE_NAME = "Wrap-up"

export interface ClosureChore {
  /** Title of the to-do the Wrap-up step creates (the stored title is "[<service name>] <this>"). */
  stepTitle: string
  /** Title of the follow-up to-do if the chore was not done by the time the company is closed. */
  cardTitle: string
  cardDescription: string
  priority: "High" | "Normal"
  category: TaskCategory
}

export const CLOSURE_CHORES: readonly ClosureChore[] = [
  {
    stepTitle: "Cancel Registered Agent on Harbor Compliance",
    cardTitle: "[CLOSURE] Remove RA on Harbor Compliance",
    cardDescription: "Company closure in progress. Remove Registered Agent service from Harbor Compliance portal.",
    priority: "High",
    category: "Filing",
  },
  {
    stepTitle: "Cancel CMRA/lease if active",
    cardTitle: "[CLOSURE] Cancel CMRA mailing address / lease if active",
    cardDescription: "Company closure. If the company has a CMRA mailing address / lease, cancel it so it stops billing.",
    priority: "Normal",
    category: "Filing",
  },
  {
    stepTitle: "Stop the yearly renewals (RA + annual report) and clear their dates",
    cardTitle: "[CLOSURE] Stop the yearly renewals (RA + annual report)",
    cardDescription:
      "Company closure. Cancel the company's State RA Renewal and State Annual Report jobs and clear their renewal dates so they stop appearing.",
    priority: "Normal",
    category: "CRM Update",
  },
]

/** The follow-up for a company that has a mailing-address lease (the CMRA): without it the lease keeps billing and the suite stays taken. */
const LEASE_CARD: ClosureFollowUpCard = {
  task_title: "[CLOSURE] Cancel CMRA mailing address / lease",
  description: "Company closure. This company has a mailing-address lease — cancel it so it stops billing and the suite goes back to the pool.",
  priority: "Normal",
  category: "Filing",
}

/** The prefix every follow-up to-do made by `buildClosureFollowUpCards` carries in its title. */
const FOLLOW_UP_PREFIX = "[CLOSURE] "

/** True for a to-do made as a closure follow-up (Harbor RA, lease…): real work still to do, never to be auto-completed with the job. */
export function isClosureFollowUpTitle(title: string | null | undefined): boolean {
  return (title ?? "").startsWith(FOLLOW_UP_PREFIX)
}

/** The bit of a to-do the decision needs. */
export interface ClosureStepTask {
  task_title: string | null
  status: string | null
}

export interface ClosureFollowUpCard {
  task_title: string
  description: string
  priority: "High" | "Normal"
  category: TaskCategory
}

function normalise(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase()
}

/** True when the job's own to-dos show this chore as done. */
function choreRecordedDone(chore: ClosureChore, jobTasks: readonly ClosureStepTask[]): boolean {
  const wanted = normalise(chore.stepTitle)
  return jobTasks.some(t => normalise(t.task_title).endsWith(wanted) && t.status === "Done")
}

/**
 * The follow-up to-dos to create when a closure job's company is closed.
 * @param jobTasks the closure job's own to-dos, read BEFORE the sweep that closes the company's open to-dos.
 *   Pass an empty list when they could not be read: every chore then gets its follow-up (the safe direction).
 * @param wrapUpStepExists whether the Company Closure step list contains the "Wrap-up" step. The step is switched on by
 *   running scripts/migrations/20261015-1200-closure-wrapup-step.sql; until then only the Harbor follow-up is created
 *   (plus the lease follow-up when the company has a lease).
 * @param hasLease the company has a mailing-address lease (signed / viewed / sent). Only used while the Wrap-up step does not
 *   exist: once it does, its own "Cancel CMRA/lease if active" chore covers the lease.
 */
export function buildClosureFollowUpCards(jobTasks: readonly ClosureStepTask[], wrapUpStepExists: boolean, hasLease = false): ClosureFollowUpCard[] {
  const harbor = CLOSURE_CHORES[0]
  if (!wrapUpStepExists) {
    return [
      { task_title: harbor.cardTitle, description: harbor.cardDescription, priority: harbor.priority, category: harbor.category },
      ...(hasLease ? [LEASE_CARD] : []),
    ]
  }
  return CLOSURE_CHORES.filter(c => !choreRecordedDone(c, jobTasks)).map(c => ({
    task_title: c.cardTitle,
    description: c.cardDescription,
    priority: c.priority,
    category: c.category,
  }))
}
