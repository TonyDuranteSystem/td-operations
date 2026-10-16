/**
 * What's New — which job a note's "Open" can go straight to (the Calendar's What's New tab; dev job 40235e3c).
 * PURE rules, unit-tested. A note's marker names the SS-4 / document / lease record, never the job, so the job is found from the company:
 * for a note about the company's own work, if the company has EXACTLY ONE open job, that is the job. Two or more = ambiguous = none
 * (the client page stays the target; a wrong workspace is worse than one more click).
 */

import { isLiveDeliveryStatus } from "@/lib/services/stages"
import { excludingCards, matchExcludingCard, type CardInput } from "@/lib/open-services/build"

/**
 * Source records that belong to a company's own work: "Open" can go to that company's job workspace instead of its client page.
 * NOT the lease: a lease belongs to the company, not to one job, so it keeps opening the client page.
 */
export const WORKSPACE_SRC_TABLES: ReadonlySet<string> = new Set(["ss4_applications", "documents"])

/** The table half of a note's source ref ("ss4_applications:uuid" -> "ss4_applications"), or "". */
export function srcTableOfRef(src: string | null | undefined): string {
  if (typeof src !== "string") return ""
  return src.split(":")[0] ?? ""
}

export interface JobLike {
  id: string
  status: string | null
  is_test: boolean | null
  service_type: string
  service_type_entry_id: string | null
}

/**
 * The company's only open job, or null when it has none or several. "Open" means what the Calendar means: a live status, not a test, and not
 * a job that lives on another page (a renewal or a tax return: the service-card flags) — so the button and the Calendar never disagree.
 */
export function soleOpenJobId(jobs: readonly JobLike[], cards: readonly CardInput[] = []): string | null {
  const ordered = excludingCards([...cards])
  const open = jobs.filter(j => j.is_test !== true && isLiveDeliveryStatus(j.status) && !matchExcludingCard(j, ordered))
  return open.length === 1 ? open[0].id : null
}
