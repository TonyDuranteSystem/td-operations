/**
 * Contact merge vs the NEW store (job 685467b5, widened by job 938af003 slice 2). Two people who BOTH have their own storage are now
 * COMBINED by the merge itself (see merge-combine.ts); this check only refuses the cases the database cannot combine — a Google Drive
 * study copy on either side, files or folders in the trash / already deleted on the removed side — and a database that cannot
 * combine at all yet. It returns the database's own plain-English reason. Fails CLOSED: a read error refuses the merge.
 */
import { getCombinePlan, type CombineLookup, type CombinePlan } from "./merge-combine"

export interface MergeGuardDeps {
  combinePlan: CombineLookup
}

export interface StoreMergeCheck {
  /** why the merge cannot run, in plain words — or null */
  blocker: string | null
  /** what the merge will do with the two storages (null when they are not combined) */
  plan: CombinePlan | null
}

export async function storeMergeCheck(loserId: string, winnerId: string, deps?: MergeGuardDeps): Promise<StoreMergeCheck> {
  const r = await getCombinePlan(loserId, winnerId, deps?.combinePlan)
  if ("error" in r) return { blocker: "Could not check the two contacts' files in the new CRM storage — please try again.", plan: null }
  if (!r.combined) return { blocker: r.blocker ?? null, plan: null }
  return { blocker: null, plan: r }
}

export async function storeMergeBlocker(loserId: string, winnerId: string, deps?: MergeGuardDeps): Promise<string | null> {
  return (await storeMergeCheck(loserId, winnerId, deps)).blocker
}
