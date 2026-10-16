/**
 * "Waiting on" kinds — the server loader (dev job 40235e3c). SERVER-ONLY, READ-ONLY.
 *
 * Reads the catalog list `step_wait_kinds` (the "waiting on someone else" kinds) and returns the full ordered list of kinds the
 * Calendar pages and the step editors use: us, the client, the catalog kinds, nobody. It follows the rule these pages already keep:
 * refuse instead of guessing.
 *   - the catalog does not exist yet (the migration has not run): the two seeded kinds (an outside office, a date), `defined: false`;
 *   - a read error: THROW (the page shows "Could not load", never a plausible-looking wrong list);
 *   - anything else: exactly what the catalog says. A step whose kind is no longer there shows as "not set" with a visible warning.
 * Retired (deprecated) kinds are read too, so the steps that already use them keep their meaning.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { assembleWaitKinds, defaultWaitKinds, type WaitKind } from "@/lib/open-services/types"
import { parseCatalogWaitKinds, type CatalogKindRow } from "@/lib/open-services/wait-kinds"

export const WAIT_KINDS_CATALOG = "step_wait_kinds"

export interface LoadedWaitKinds {
  /** Every kind, in display order: us, the client, the catalog kinds, nobody. */
  kinds: WaitKind[]
  /** Plain-words problems found in the list (a row skipped...). */
  problems: string[]
  /** false = the catalog has not been set up yet (the built-in defaults are in use). */
  defined: boolean
}

export async function loadWaitKinds(): Promise<LoadedWaitKinds> {
  const def = await supabaseAdmin.from("catalog_definitions").select("id").eq("id", WAIT_KINDS_CATALOG).maybeSingle()
  if (def.error) throw new Error(`wait-kinds: could not read the list definition: ${def.error.message}`)
  if (!def.data) return { kinds: defaultWaitKinds(), problems: [], defined: false }

  const rows = await supabaseAdmin
    .from("catalog_entries")
    .select("slug, display_name, status, metadata")
    .eq("catalog_id", WAIT_KINDS_CATALOG)
    .in("status", ["active", "deprecated"])
  if (rows.error) throw new Error(`wait-kinds: could not read the list: ${rows.error.message}`)

  const parsed = parseCatalogWaitKinds((rows.data ?? []) as unknown as CatalogKindRow[])
  return { kinds: assembleWaitKinds(parsed.kinds), problems: parsed.problems, defined: true }
}
