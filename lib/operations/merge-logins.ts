/**
 * Contact merge slice 3 (dev job 938af003): APPLY the login choice after the database merge has succeeded.
 * Auth users live outside the database transaction, so the order is what keeps it safe:
 *   1. a login that moves is re-pointed at the kept contact FIRST and read back;
 *   2. only when that is confirmed, the logins that must go are deleted.
 * If the move fails or cannot be confirmed, NOTHING is deleted and the caller says so in plain words.
 * Only ids that belong to the pair (read in the same scan the choice was checked against) can ever be touched.
 * Pure decision: `lib/contacts/merge-logins.ts`. This file has injectable deps so the order is unit-tested without Supabase.
 */
import type { User } from "@supabase/supabase-js"
import { loginActions, type LoginChoice, type LoginActions } from "@/lib/contacts/merge-logins"

export interface MergeLoginDeps {
  getUser: (id: string) => Promise<User | null>
  setAppMetadata: (id: string, appMetadata: Record<string, unknown>) => Promise<{ error: string | null }>
  deleteUser: (id: string) => Promise<{ error: string | null }>
  /** the portal tier the kept contact already has (never written here: it is only copied onto the moved login) */
  keptTier: () => Promise<string | null>
}

export interface MergeLoginResult {
  choice: LoginChoice
  moved: string | null
  deleted: string[]
  deleteFailed: string[]
  /** set when the move failed: nothing was deleted */
  error: string | null
}

export async function applyLoginChoice(
  choice: LoginChoice,
  removed: User[],
  kept: User[],
  keptContactId: string,
  deps: MergeLoginDeps,
): Promise<MergeLoginResult> {
  const actions: LoginActions = loginActions(choice, removed.map((u) => ({ id: u.id, working: true })), kept.map((u) => ({ id: u.id, working: true })))
  const result: MergeLoginResult = { choice, moved: null, deleted: [], deleteFailed: [], error: null }

  if (actions.moveId) {
    const fresh = await deps.getUser(actions.moveId)
    if (!fresh) return { ...result, error: "The login to move could not be read." }
    const tier = await deps.keptTier()
    const next: Record<string, unknown> = { ...(fresh.app_metadata ?? {}), contact_id: keptContactId }
    if (tier) next.portal_tier = tier
    const set = await deps.setAppMetadata(actions.moveId, next)
    if (set.error) return { ...result, error: `The login could not be moved: ${set.error}` }
    const back = await deps.getUser(actions.moveId)
    if ((back?.app_metadata as { contact_id?: string } | undefined)?.contact_id !== keptContactId) {
      return { ...result, error: "The login was moved but could not be confirmed." }
    }
    result.moved = actions.moveId
  }

  const pair = new Set([...removed, ...kept].map((u) => u.id))
  for (const id of actions.deleteIds) {
    if (!pair.has(id) || id === actions.moveId) continue   // never anything outside the pair, never the login that was just moved
    const del = await deps.deleteUser(id)
    if (del.error) result.deleteFailed.push(id)
    else result.deleted.push(id)
  }
  return result
}

/** The real deps (service role). */
export async function realMergeLoginDeps(keptContactId: string): Promise<MergeLoginDeps> {
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  return {
    getUser: async (id) => {
      const { data, error } = await supabaseAdmin.auth.admin.getUserById(id)
      return error ? null : (data?.user ?? null)
    },
    setAppMetadata: async (id, appMetadata) => {
      const { error } = await supabaseAdmin.auth.admin.updateUserById(id, { app_metadata: appMetadata })
      return { error: error?.message ?? null }
    },
    deleteUser: async (id) => {
      const { error } = await supabaseAdmin.auth.admin.deleteUser(id)
      return { error: error?.message ?? null }
    },
    keptTier: async () => {
      const { computeContactTier } = await import("@/lib/operations/sync-tier")
      return (await computeContactTier(keptContactId).catch(() => null)) as string | null
    },
  }
}
