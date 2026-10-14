/* eslint-disable no-console */
/* sandbox only: removes the duplicate pending activations left by the "signing fired twice" QA run (keeps the oldest per token) */
import { config } from "dotenv"
config({ path: ".env.local" })
async function main() {
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("xjcxlmlpeywtwkhstjlw")) throw new Error("sandbox only")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const db = supabaseAdmin as any // eslint-disable-line @typescript-eslint/no-explicit-any
  const { data } = await db.from("pending_activations").select("id, offer_token, created_at").order("created_at", { ascending: true })
  const seen = new Set<string>()
  const drop: string[] = []
  for (const r of data ?? []) { if (seen.has(r.offer_token)) drop.push(r.id); else seen.add(r.offer_token) }
  console.log("duplicates to remove:", drop.length)
  for (let i = 0; i < drop.length; i += 50) await db.from("pending_activations").delete().in("id", drop.slice(i, i + 50))
}
main()
