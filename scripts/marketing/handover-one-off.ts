/* eslint-disable no-console */
/* TD Marketing — the ONE-OFF data step for the new hand-over (dev job 9aec66fa, plan of 3 Nov 2026, Release 1).
   Booking the free call now makes the lead the seller's. Leads that were booked or passed BEFORE this change are still "not picked" and some sit at Rocco's old "Contacted" step. This script:
     1. gives every booked / shown lead the seller as its owner (the pick) when nobody picked it, so his "Link con Antonio" box and his calendar/time zone/signature work on it;
     2. moves a lead at the old "Contacted" step (seller_contacted) back to "booked", so it shows to him under "After the call" and he chooses a result;
   It does NOT touch the call times: a booked lead with a call still ahead stays under "Calls prenotate", one whose call time has passed (or has none) shows under "After the call" by itself.
   DRY RUN BY DEFAULT: it only prints what it would do. Add --apply to write. It refuses the PRODUCTION database unless ALLOW_PRODUCTION_ONE_OFF=1 is set (only on Antonio's word, after he saw the dry run).
   Usage:  npx tsx scripts/marketing/handover-one-off.ts --team <team uuid> --seller <seller user uuid> [--apply]
   Re-running is safe: leads already handled are skipped. Every change writes a history line from "system". */
import { config } from "dotenv"
config({ path: ".env.local" })
import { Client } from "pg"
import { planOneOff, type OneOffEvent, type OneOffLead, type OneOffPlan } from "@/lib/marketing/handover-one-off"

const PROD_REF = "ydzipybqeebtpcvsbtvs"
const argv = process.argv.slice(2)
const arg = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
const APPLY = argv.includes("--apply")
const ACTOR = "system"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface LeadRow extends OneOffLead { full_name: string | null; email: string | null }
interface Plan extends OneOffPlan { lead: LeadRow }

async function main() {
  const team = arg("team"), seller = arg("seller")
  if (!team || !UUID.test(team) || !seller || !UUID.test(seller)) throw new Error("Give --team <uuid> and --seller <uuid>.")
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
  if (url.includes(PROD_REF) && process.env.ALLOW_PRODUCTION_ONE_OFF !== "1") throw new Error("This is the PRODUCTION database. Sandbox first; production only on Antonio's word (ALLOW_PRODUCTION_ONE_OFF=1).")
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} on ${url.replace(/^https:\/\//, "").split(".")[0]}`)
  const db = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } })
  await db.connect()
  try {
    const who = await db.query("select m.user_id, u.email from marketing_team_members m join auth.users u on u.id = m.user_id where m.team_id = $1 and m.user_id = $2 and m.status = 'active'", [team, seller])
    if (who.rowCount !== 1) throw new Error("That seller is not an active member of that team.")
    const sellerEmail = who.rows[0].email as string
    const leads = (await db.query("select id, full_name, email, status, claimed_by from marketing_leads where team_id = $1 and status in ('booked','showed','seller_contacted') order by received_at", [team])).rows as LeadRow[]
    const now = new Date()
    const plans: Plan[] = []
    for (const lead of leads) {
      const ev = (await db.query("select kind, data, created_at from marketing_lead_events where lead_id = $1 and kind = 'appointment' order by created_at", [lead.id])).rows.map(r => ({ ...r, created_at: new Date(r.created_at).toISOString() })) as OneOffEvent[]
      plans.push({ lead, ...planOneOff(lead, ev, now) })
    }
    for (const p of plans) console.log(`${p.lead.id}  ${(p.lead.full_name ?? p.lead.email ?? "(no name)").padEnd(28)} ${p.lead.status.padEnd(16)} call=${p.call ?? "none"}  pick=${p.pick ? "SET" : p.lead.claimed_by ? "kept" : "-"}  ${p.toBooked ? "stage->booked  " : ""}shows: ${p.shows}`)
    const todo = plans.filter(p => p.pick || p.toBooked)
    console.log(`\n${plans.length} lead(s) looked at; ${plans.filter(p => p.shows === "Calls prenotate").length} under Calls prenotate, ${plans.filter(p => p.shows === "After the call").length} under After the call; ${todo.length} to change.`)
    if (!APPLY) { console.log("Dry run: nothing was written. Add --apply to write."); return }
    let done = 0
    for (const p of todo) {
      await db.query("begin")
      try {
        const set: string[] = []
        const vals: unknown[] = []
        if (p.pick) { set.push(`claimed_by = $${vals.push(seller)}`, `claimed_by_label = $${vals.push(sellerEmail)}`, `claimed_at = now()`) }
        if (p.toBooked) set.push(`status = 'booked'`, `callback_at = null`)
        set.push("updated_at = now()")
        // only if the lead is still as it was read (same stage, still unpicked when we are picking): a lead changed meanwhile is skipped, never overwritten
        const r = await db.query(`update marketing_leads set ${set.join(", ")} where id = $${vals.push(p.lead.id)} and team_id = $${vals.push(team)} and status = $${vals.push(p.lead.status)} and ${p.lead.claimed_by === null ? "claimed_by is null" : `claimed_by = $${vals.push(p.lead.claimed_by)}`}`, vals)
        if (r.rowCount !== 1) { await db.query("rollback"); console.log(`SKIPPED (changed meanwhile): ${p.lead.id}`); continue }
        if (p.pick) await db.query("insert into marketing_lead_events (lead_id, kind, actor, data) values ($1, 'claimed', $2, $3)", [p.lead.id, ACTOR, JSON.stringify({ handed_to: seller, one_off: true })])
        if (p.toBooked) await db.query("insert into marketing_lead_events (lead_id, kind, actor, data) values ($1, 'status_changed', $2, $3)", [p.lead.id, ACTOR, JSON.stringify({ from: "seller_contacted", to: "booked", outcome: "one_off_handover", note: "The seller's Contacted step was removed; the lead now waits for the answer about its call." })])
        await db.query("commit")
        done++
      } catch (e) { await db.query("rollback"); throw e }
    }
    console.log(`Done: ${done} lead(s) changed.`)
  } finally { await db.end() }
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
