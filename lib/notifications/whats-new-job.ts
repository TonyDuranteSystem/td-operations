/**
 * What's New — which job a note's "Open" can go straight to (the Calendar's What's New tab; dev job 40235e3c).
 * PURE rules, unit-tested. A note's marker names the SS-4 / document / lease record, never the job, so the job is found from the company:
 * for a note about the company's own work, if the company has EXACTLY ONE open job, that is the job. Two or more = ambiguous = none
 * (the client page stays the target; a wrong workspace is worse than one more click).
 */

import { isLiveDeliveryStatus } from "@/lib/services/stages"

/** Source records that belong to a company's own work: "Open" can go to that company's job workspace instead of its client page. */
export const WORKSPACE_SRC_TABLES: ReadonlySet<string> = new Set(["ss4_applications", "documents", "lease_agreements"])

/** The table half of a note's source ref ("ss4_applications:uuid" -> "ss4_applications"), or "". */
export function srcTableOfRef(src: string | null | undefined): string {
  if (typeof src !== "string") return ""
  return src.split(":")[0] ?? ""
}

export interface JobLike {
  id: string
  status: string | null
  is_test: boolean | null
}

/** The company's only open (live, non-test) job, or null when it has none or several. */
export function soleOpenJobId(jobs: readonly JobLike[]): string | null {
  const open = jobs.filter(j => j.is_test !== true && isLiveDeliveryStatus(j.status))
  return open.length === 1 ? open[0].id : null
}
