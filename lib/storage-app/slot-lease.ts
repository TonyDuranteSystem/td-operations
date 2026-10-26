/**
 * An upload slot is claimed with a 15-minute lease while it is being saved (store_claim_intent). When a save stops BEFORE the slot is used up
 * (the staged file could not be read, or the safe save threw a transient error), the lease must be given back — otherwise the Mac's retry is
 * answered "slot_busy" (409, which the shipped Mac does not retry) until the lease runs out. Only a slot that is still open is touched.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
type AnyClient = any

/** Gives the lease of an open slot back. Never throws: the lease also runs out by itself. Returns true when the update call went through. */
export async function releaseSlotClaim(client: AnyClient, intentId: string): Promise<boolean> {
  try {
    const { error } = await client.from("store_upload_intents").update({ claimed_at: null, lease_until: null }).eq("id", intentId).is("consumed_at", null)
    return !error
  } catch {
    return false
  }
}
