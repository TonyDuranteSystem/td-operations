/**
 * Server-side loader: resolve the stage set for a job type from the catalog
 * (catalog_id='dev_stage_sets') merged over the built-in sets. Kept separate
 * from the pure stage-sets module so that module stays client-safe.
 */
import { mergeStageSets, resolveStageSet, stageSetFromMetadata } from "./stage-sets"
import type { StageSet } from "./milestones"

export async function loadStageSetForType(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  type: string | null | undefined,
): Promise<StageSet> {
  const { data } = await db
    .from("catalog_entries")
    .select("slug, display_name, metadata")
    .eq("catalog_id", "dev_stage_sets")
    .eq("status", "active")
  const catalog: Record<string, StageSet> = {}
  for (const r of (data || []) as Array<{ slug: string; display_name: string; metadata: unknown }>) {
    const set = stageSetFromMetadata(r.slug, r.display_name, r.metadata)
    if (set) catalog[r.slug] = set
  }
  return resolveStageSet(type, mergeStageSets(catalog))
}
