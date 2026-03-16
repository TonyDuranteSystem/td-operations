/**
 * Job Handler Registry — maps job_type to handler functions.
 * Add new job types here as the system grows.
 */

import type { Job, JobResult } from "./queue"
import { handleOnboardingSetup } from "./handlers/onboarding-setup"
import { handleFormationSetup } from "./handlers/formation-setup"
import { handleTaxFormSetup } from "./handlers/tax-form-setup"
import { handleWelcomePackagePrepare } from "./handlers/welcome-package-setup"

type JobHandler = (job: Job) => Promise<JobResult>

const handlers: Record<string, JobHandler> = {
  onboarding_setup: handleOnboardingSetup,
  formation_setup: handleFormationSetup,
  tax_form_setup: handleTaxFormSetup,
  welcome_package_prepare: handleWelcomePackagePrepare,
}

export function getJobHandler(jobType: string): JobHandler | null {
  return handlers[jobType] || null
}

export function getRegisteredJobTypes(): string[] {
  return Object.keys(handlers)
}
