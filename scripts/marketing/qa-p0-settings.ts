/* eslint-disable no-console */
/* LOCAL private stack only: proves the TD Marketing P0 settings storage end to end (dev job 9aec66fa). */
import { config } from "dotenv"
config({ path: ".env.local" })
import { Client } from "pg"

async function main() {
  const url = process.env.SUPABASE_DB_URL ?? ""
  const api = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
  if (!api.includes("127.0.0.1") || !url.includes("127.0.0.1")) throw new Error("local private stack only")
  const db = new Client({ connectionString: url })
  await db.connect()
  let pass = 0, fail = 0
  const ck = (id: string, ok: boolean, note?: unknown) => { if (ok) pass++; else fail++; console.log(ok ? "PASS" : "FAIL", id, ok ? "" : JSON.stringify(note)) }
  const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows

  const S = await import("@/lib/marketing/settings")
  const C = await import("@/lib/marketing/commission")
  const stamp = Date.now()
  const actor = "qa-p0"

  // a team starts draft
  const t = await S.createTeam({ name: `QA Team ${stamp}`, actor })
  ck("1 team created as draft", t.ok === true && t.data?.status === "draft", t)
  const teamId = t.data!.id
  ck("2 draft is not live", (await import("@/lib/marketing/team-status")).isTeamLive(t.data!.status) === false)
  const bad = await S.createTeam({ name: "   ", actor })
  ck("3 empty team name refused", bad.ok === false, bad)

  // settings: default, team value, global value, bad value, unknown key
  ck("4 default when nothing stored", ((await S.getMarketingSetting("pipeline_stages", teamId)) as unknown[]).length === 7)
  const set1 = await S.setMarketingSetting({ key: "owner_may_create_offers", value: true, actor, teamId })
  ck("5 team value saved", set1.ok === true, set1)
  ck("6 team value read back", (await S.getMarketingSetting("owner_may_create_offers", teamId)) === true)
  ck("7 other team / global still default", (await S.getMarketingSetting("owner_may_create_offers", null)) === false)
  const badSet = await S.setMarketingSetting({ key: "owner_may_create_offers", value: "yes", actor, teamId })
  ck("8 bad value refused, not stored", badSet.ok === false && (await S.getMarketingSetting("owner_may_create_offers", teamId)) === true, badSet)
  ck("9 unknown key refused", (await S.setMarketingSetting({ key: "hack", value: 1, actor })).ok === false)
  await S.setMarketingSetting({ key: "owner_may_create_offers", value: false, actor, teamId })
  const hist = await S.getSettingHistory("owner_may_create_offers")
  const mine = hist.filter((h: { team_id: string }) => h.team_id === teamId)
  ck("10 every change wrote history (2 for this team)", mine.length === 2, mine.length)
  ck("11 history keeps old and new", mine[0].old_value === true && mine[0].new_value === false, mine[0])
  await S.setMarketingSetting({ key: "owner_may_create_offers", value: false, actor, teamId })
  ck("12 saving the same value writes no new history", (await S.getSettingHistory("owner_may_create_offers")).filter((h: { team_id: string }) => h.team_id === teamId).length === 2)

  // history is append-only at the database
  let blocked = false
  try { await db.query("update marketing_settings_history set key='x' where team_id=$1", [teamId]) } catch { blocked = true }
  ck("13 history cannot be changed", blocked)
  blocked = false
  try { await db.query("delete from marketing_settings_history where team_id=$1", [teamId]) } catch { blocked = true }
  ck("14 history cannot be deleted", blocked)

  // commission terms
  const none = C.termInForce(await S.listCommissionTerms(teamId), { teamId, kind: "strategic_call", at: new Date() })
  ck("15 no terms yet = terms not set", none === null)
  const a = await S.addCommissionTerm({ teamId, kind: "strategic_call", sellerPct: 80, payeeAccountId: "a2d2f660-8da9-4645-a478-54a8c1c1339d", effectiveFrom: "2026-10-17T00:00:00Z", actor })
  ck("16 80/20 term added, TD gets 20", a.ok === true && a.data?.td_pct === 20, a)
  const b = await S.addCommissionTerm({ teamId, kind: "strategic_call", sellerPct: 70, effectiveFrom: "2026-12-01T00:00:00Z", actor })
  ck("17 a later rate is a NEW row", b.ok === true)
  const terms = await S.listCommissionTerms(teamId)
  ck("18 sale before the change keeps 80", C.termInForce(terms, { teamId, kind: "strategic_call", at: new Date("2026-11-01") })?.seller_pct === 80)
  ck("19 sale after the change gets 70", C.termInForce(terms, { teamId, kind: "strategic_call", at: new Date("2026-12-05") })?.seller_pct === 70)
  ck("20 unknown kind refused", (await S.addCommissionTerm({ teamId, kind: "nonsense", sellerPct: 50, actor })).ok === false)
  ck("21 101% refused", (await S.addCommissionTerm({ teamId, kind: "upsell", sellerPct: 101, actor })).ok === false)
  blocked = false
  try { await db.query("update marketing_commission_terms set seller_pct=1 where team_id=$1", [teamId]) } catch { blocked = true }
  ck("22 a term cannot be edited", blocked)
  blocked = false
  try { await db.query("delete from marketing_commission_terms where team_id=$1", [teamId]) } catch { blocked = true }
  ck("23 a term cannot be deleted", blocked)
  blocked = false
  try { await db.query("insert into marketing_commission_terms (team_id,kind,seller_pct,td_pct) values ($1,'x',80,30)", [teamId]) } catch { blocked = true }
  ck("24 shares that do not add to 100 refused by the database", blocked)

  // status flow
  const act = await S.setTeamStatus(teamId, "active", actor)
  ck("25 draft -> active", act.ok === true && act.data?.status === "active", act)
  ck("26 active -> draft refused", (await S.setTeamStatus(teamId, "draft", actor)).ok === false)
  ck("27 active -> paused", (await S.setTeamStatus(teamId, "paused", actor)).ok === true)

  // RLS: no browser role can read these
  const rls = await q("select relname, relrowsecurity from pg_class where relname in ('marketing_teams','marketing_settings','marketing_settings_history','marketing_commission_terms')")
  ck("28 row-level security on all four tables", rls.length === 4 && rls.every((r: { relrowsecurity: boolean }) => r.relrowsecurity === true), rls)

  // clean up this run's rows (history/terms are append-only: remove through the team cascade by dropping the triggers is NOT allowed; leave the QA team in the private stack)
  console.log(`\n${pass} pass, ${fail} fail`)
  await db.end()
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
