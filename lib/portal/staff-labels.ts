// Server side of the staff-name label (dev job 8d077f3b): looks a staff login up in Supabase Auth and remembers the answer for ten minutes.
// The rules (which logins get a name, what the name is) live in lib/portal/staff-display-name.ts, which has no server imports and is unit-tested.
import { supabaseAdmin } from '@/lib/supabase-admin'
import { newStaffLabelCache, resolveStaffLabels, type StaffLookupUser } from '@/lib/portal/staff-display-name'

const cache = newStaffLabelCache()

async function lookupAuthUser(id: string): Promise<StaffLookupUser | null> {
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(id)
  if (error) {
    // a login that no longer exists is a settled answer ("TD Team"); any other failure is thrown so it is not remembered and is tried again
    if ((error as { status?: number }).status === 404 || /not.?found/i.test(error.message)) return null
    throw error
  }
  return data?.user ?? null
}

/** staff user id -> first name to show, or null for "TD Team". Never throws. */
export async function staffLabelsFor(ids: Iterable<string | null | undefined>): Promise<Map<string, string | null>> {
  try {
    return await resolveStaffLabels(ids, lookupAuthUser, cache)
  } catch {
    return new Map()
  }
}
