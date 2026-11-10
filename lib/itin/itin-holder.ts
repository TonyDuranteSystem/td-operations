/**
 * Does ANOTHER contact's record already hold this ITIN? (dev job fb49265a — shared by the chat "Save to Storage" ITIN card and the Storage
 * upload's automatic fill-in, so a letter put on the wrong person is caught the same way in both.)
 *
 * Returns the other contact's name, null when nobody else holds it, or "error" when that could not be checked — a caller must then treat the
 * letter as NOT safe to write, never as "nobody holds it".
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- contacts select is loose here
const db = () => supabaseAdmin as any

export async function otherHolderOfItin(itin: string, contactId: string): Promise<string | null | "error"> {
  // compared on the DIGITS: records hold the number as 999-99-9999, 999999999, "999 99 9999" and one older "999-999999" — a list of spellings would miss the next odd one
  const digits = itin.replace(/\D/g, "")
  const { data, error } = await db().from("contacts").select("full_name, itin_number").ilike("itin_number", `%${digits.slice(-4)}%`).neq("id", contactId).limit(50)
  if (error) return "error"
  const row = ((data ?? []) as Array<{ full_name: string | null; itin_number: string | null }>).find((r) => (r.itin_number ?? "").replace(/\D/g, "") === digits)
  return row ? (row.full_name || "another contact") : null
}
