/**
 * Contact merge vs the NEW store (job 685467b5). merge_contacts() re-points every contacts FK from the
 * loser to the winner — including store_owners.contact_id, which is UNIQUE (one storage per person).
 * If BOTH people already have their own storage the merge would fail inside the database with a raw
 * unique-violation; this check refuses it first, in plain words. Only the loser having storage is fine
 * (it simply becomes the winner's). Fails CLOSED: a read error refuses the merge.
 */
export interface MergeGuardDeps {
  personOwners: (contactIds: string[]) => Promise<{ contactIds: string[] } | { error: string }>
}

export async function storeMergeBlocker(loserId: string, winnerId: string, deps?: MergeGuardDeps): Promise<string | null> {
  const d = deps ?? (await defaultDeps())
  if (!d) return null
  const r = await d.personOwners([loserId, winnerId])
  if ("error" in r) return "Could not check the two contacts' files in the new CRM storage — please try again."
  if (r.contactIds.includes(loserId) && r.contactIds.includes(winnerId)) {
    return "Both contacts already have their own files in the new CRM storage. Those two storages cannot be merged automatically yet — ask for them to be combined first, then merge the contacts."
  }
  return null
}

async function defaultDeps(): Promise<MergeGuardDeps | null> {
  // runs wherever people's storage can exist (the pilot, study copies — and after a switch is turned off again,
  // the storages are still there): where the store's tables don't exist yet there is nothing to guard
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  return {
    personOwners: async (ids) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
      const { data, error } = await (supabaseAdmin as any).from("store_owners").select("contact_id").in("contact_id", ids)
      if (error && /does not exist|schema cache/i.test(error.message)) return { contactIds: [] }
      if (error) return { error: error.message as string }
      return { contactIds: ((data ?? []) as { contact_id: string }[]).map((x) => x.contact_id) }
    },
  }
}
