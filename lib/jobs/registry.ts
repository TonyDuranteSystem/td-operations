/**
 * Job Handler Registry — maps job_type to handler functions.
 * Add new job types here as the system grows.
 */

import type { Job, JobResult } from "./queue"
import { handleOnboardingSetup } from "./handlers/onboarding-setup"

type JobHandler = (job: Job) => Promise<JobResult>

const handlers: Record<string, JobHandler> = {
  onboarding_setup: handleOnboardingSetup,
  // Future handlers:
  // formation_setup: handleFormationSetup,
  // doc_bulk_process: handleDocBulkProcess,
  // tax_form_setup: handleTaxFormSetup,
}

export function getJobHandler(jobType: string): JobHandler | null {
  return handlers[jobType] || null
}

export function getRegisteredJobTypes(): string[] {
  return Object.keys(handlers)
}
