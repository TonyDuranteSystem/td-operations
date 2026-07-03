/* eslint-disable no-console -- QA harness; console output IS the product */
/**
 * Phase 2b live QA — location-period triage, full write path against a REAL
 * server (local dev server on the worktree code) + the SANDBOX DB.
 *
 * Covers the dual-review required tests that live at the PostgREST layer and
 * can't be vitest'd: the NULL-notes sweep inclusion (engineer round-2 cond. 1),
 * manual-row skip, exact ai:high prior-state undo, double-undo 409, duplicate
 * submit 409 with no orphan header, aiPending/stale/count-mismatch 409s,
 * zero learned-rule writes, telemetry on ai:high flips.
 *
 * Run:
 *   npx next dev -p 3210   (in the worktree, .env.local = sandbox)
 *   npx tsx --env-file=.env.local scripts/qa/period-answer-live-qa.ts
 * Seeds an isolated workspace + a temp staff auth user; deletes both at the end.
 */
import { createClient as createSb } from "@supabase/supabase-js"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { recategorizeWorkspace } from "@/lib/tax/workspace-recategorize"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

const BASE = process.env.QA_BASE_URL ?? "http://localhost:3210"
const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SB_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const REF = new URL(SB_URL).hostname.split(".")[0]

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name} ${detail}`) }
  else { fail++; console.log(`  ❌ FAIL ${name} ${detail}`) }
}

/** @supabase/ssr cookie encoding: "base64-" + base64url(JSON session), chunked at 3180. */
function sessionCookies(session: unknown): string {
  const raw = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url")
  const name = `sb-${REF}-auth-token`
  if (raw.length <= 3180) return `${name}=${raw}`
  const parts: string[] = []
  for (let i = 0; i * 3180 < raw.length; i++) parts.push(`${name}.${i}=${raw.slice(i * 3180, (i + 1) * 3180)}`)
  return parts.join("; ")
}

const day = (iso: string) => iso // clarity alias

async function main() {
  console.log(`\n== PHASE 2B LIVE QA (server ${BASE}, DB ${REF}) ==`)

  // ---- temp staff user (any non-client role is a dashboard user) ----
  const email = `qa-2b-${Date.now()}@tonydurante.us`
  const password = `QA2b!${Math.random().toString(36).slice(2)}${Date.now() % 997}`
  const { data: created, error: userErr } = await db.auth.admin.createUser({ email, password, email_confirm: true })
  if (userErr) throw new Error(`temp user: ${userErr.message}`)
  const userId = created.user.id
  const anon = createSb(SB_URL, SB_ANON, { auth: { persistSession: false } })
  const { data: signIn, error: signErr } = await anon.auth.signInWithPassword({ email, password })
  if (signErr || !signIn.session) throw new Error(`sign-in: ${signErr?.message}`)
  const cookie = sessionCookies(signIn.session)
  const http = (path: string, init?: RequestInit) =>
    fetch(`${BASE}${path}`, { ...init, headers: { "Content-Type": "application/json", Cookie: cookie, ...(init?.headers ?? {}) }, redirect: "manual" })

  // ---- seed workspace ----
  const { data: ws, error: wsErr } = await db.from("pnl_workspaces")
    .insert({ tax_year: 2025, entity_type: "MMLLC", company_name: "QA Loc LLC", created_by: "qa-2b" })
    .select("id").single()
  if (wsErr) throw new Error(wsErr.message)
  const WS = ws.id as string
  console.log(`workspace: ${WS}`)

  try {
    // Rows: 8 weeks (Mon 2025-02-03 …) of EU (Glovo, map) + PT (Lisboa, text),
    // 3 weeks of AE (Talabat), income, manual, ai:high — every class the sweep
    // must include/skip.
    const rows: Record<string, unknown>[] = []
    const mk = (date: string, description: string, amount: number, extra: Record<string, unknown> = {}) =>
      rows.push({ workspace_id: WS, tax_year: 2025, transaction_date: date, description, counterparty: "", amount, currency: "USD", bank_name: "Mercury", account_type: "checking", transaction_ref: `qa2b-${rows.length}`, category: "uncategorized", subcategory: "", notes: null, ...extra })
    const mon = (w: number, d = 0) => new Date(Date.UTC(2025, 1, 3) + (w * 7 + d) * 86400000).toISOString().slice(0, 10)

    for (let w = 0; w < 8; w++) {
      // 3 Glovo/week: weeks 0-1 carry the special rows, rest are NULL-notes uncategorized.
      mk(mon(w, 0), `Glovo ${w}A`, -20)
      mk(mon(w, 1), `Glovo ${w}B`, -22)
      if (w < 4) mk(mon(w, 2), `Glovo ${w}C hotel run`, -30, { category: "expense", notes: "ai:high@v2", ai_bucket: "travel" })
      else if (w < 6) mk(mon(w, 2), `Glovo ${w}C`, -25, { category: "expense", notes: "manual: staff answer (business_expense)" })
      else mk(mon(w, 2), `Glovo ${w}C`, -25)
      // 2 Lisboa text rows/week (PT period; merges with EU).
      mk(mon(w, 3), `Card Purchase 0${(w % 7) + 1}/15 Farmacia Exposul Lisboa Card 5790`, -18)
      mk(mon(w, 4), `Card Purchase 0${(w % 7) + 1}/16 Padaria Central Lisboa Card 5790`, -12)
    }
    for (let w = 18; w < 21; w++) { // AE stay, no overlap with the EU weeks
      mk(mon(w, 0), `talabat pro Dubai ${w}`, -15)
      mk(mon(w, 2), `Cars Taxi Services ${w}`, -9)
    }
    for (let w = 0; w < 3; w++) mk(mon(w, 5), `Stripe payout ${w}`, 500, { category: "income" })
    const { error: insErr } = await db.from("pnl_workspace_transactions").insert(rows)
    if (insErr) throw new Error(insErr.message)

    // Deterministic pass stamps loc_* (the real labeler, not a reimplementation).
    await recategorizeWorkspace(WS, { linkedAccountId: null, companyName: "QA Loc LLC", memberNames: [] })
    await db.from("pnl_workspaces").update({ generated_at: new Date().toISOString() }).eq("id", WS)

    const { data: locSample } = await db.from("pnl_workspace_transactions")
      .select("description, loc_code, loc_source, category, notes").eq("workspace_id", WS)
    const sample = (locSample ?? []) as Array<{ description: string; loc_code: string | null; loc_source: string | null; category: string; notes: string | null }>
    ok("labeler: Glovo → EU/map", sample.filter(r => r.description.startsWith("Glovo")).every(r => r.loc_code === "EU" && r.loc_source === "map"))
    ok("labeler: Lisboa text → PT/text", sample.filter(r => r.description.includes("Lisboa")).every(r => r.loc_code === "PT" && r.loc_source === "text"))
    ok("labeler: income rows never located", sample.filter(r => r.category === "income").every(r => r.loc_code === null))

    // ---- GET: periods detected ----
    const view1 = await (await http(`/api/tools/pnl/${WS}`)).json()
    const merged = (view1.periods ?? []).find((p: { primary: string }) => p.primary === "PT")
    const ae = (view1.periods ?? []).find((p: { primary: string }) => p.primary === "AE")
    ok("GET: merged PT+EU period (containment, one card — no double-ask)", !!merged && merged.loc_codes.includes("EU") && merged.loc_codes.includes("PT"))
    ok("GET: AE period detected separately", !!ae)
    ok("GET: no residence on file flagged", view1.residence_on_file === false)
    if (!merged) throw new Error("no merged period — cannot continue")
    // 8w × (2 uncat + 1 special) Glovo + 16 PT rows; sweepable = all except 2 manual.
    ok("GET: merged sweepable excludes exactly the manual rows", merged.row_count - merged.sweepable_count === 2, `row_count=${merged.row_count} sweepable=${merged.sweepable_count}`)

    const rulesBefore = (await db.from("bank_categorization_rules").select("id", { count: "exact", head: true }).eq("workspace_id", WS)).count ?? 0

    // ---- guard 409s (before any sweep) ----
    const body = (over: Record<string, unknown> = {}) => JSON.stringify({
      loc_codes: merged.loc_codes, period_start: merged.start, period_end: merged.end,
      choice: "personal", expected_row_count: merged.sweepable_count, expected_dollar_total: merged.sweepable_total, ...over,
    })
    let res = await http(`/api/tools/pnl/${WS}/period-answer`, { method: "POST", body: body({ expected_row_count: merged.sweepable_count - 1 }) })
    ok("409 on count mismatch", res.status === 409)

    const { data: fakeJob } = await db.from("job_queue").insert({ job_type: "recategorize_workspace_ai", status: "pending", related_entity_id: WS, payload: { qa: true } }).select("id").single()
    res = await http(`/api/tools/pnl/${WS}/period-answer`, { method: "POST", body: body() })
    ok("409 while AI job pending (recomputed server-side)", res.status === 409)
    await db.from("job_queue").delete().eq("id", fakeJob.id)

    await db.from("pnl_workspace_transactions").insert({ workspace_id: WS, tax_year: 2025, transaction_date: day("2025-09-01"), description: "late upload row", amount: -5, currency: "USD", transaction_ref: "qa2b-late", category: "uncategorized", subcategory: "" })
    res = await http(`/api/tools/pnl/${WS}/period-answer`, { method: "POST", body: body() })
    ok("409 while stale (statement added after generation)", res.status === 409)
    await db.from("pnl_workspaces").update({ generated_at: new Date().toISOString() }).eq("id", WS)

    // ---- happy sweep: ALL PERSONAL (exercises the ai:high flip + telemetry) ----
    res = await http(`/api/tools/pnl/${WS}/period-answer`, { method: "POST", body: body() })
    const sweep = await res.json()
    ok("sweep 200", res.status === 200, JSON.stringify(sweep))
    ok("sweep: swept = confirmed count", sweep.swept === merged.sweepable_count)
    ok("sweep: skipped_manual = 2", sweep.skipped_manual === 2)

    const { data: after } = await db.from("pnl_workspace_transactions")
      .select("description, category, subcategory, notes, ai_bucket").eq("workspace_id", WS)
    const a = (after ?? []) as Array<{ description: string; category: string; subcategory: string; notes: string | null; ai_bucket: string | null }>
    const nullNotesSwept = a.filter(r => r.description.match(/^Glovo \dA$/))
    ok("NULL-notes rows WERE swept (the three-valued-logic trap)", nullNotesSwept.every(r => r.category === "distribution" && (r.notes ?? "").startsWith("manual: period answer ")))
    ok("manual rows untouched", a.filter(r => (r.notes ?? "").startsWith("manual: staff answer")).length === 2)
    ok("ai:high rows flipped to distribution, ai_bucket preserved", a.filter(r => r.description.includes("hotel run")).every(r => r.category === "distribution" && r.ai_bucket === "travel"))
    ok("income rows untouched", a.filter(r => r.category === "income").length === 3)

    const { data: hdr } = await db.from("pnl_period_answers").select("id, row_count, dollar_total, actor_role, undone_at").eq("workspace_id", WS)
    ok("one batch header, actual counts, staff actor", (hdr ?? []).length === 1 && hdr[0].row_count === sweep.swept && hdr[0].actor_role === "staff")
    const batchId = hdr![0].id as string
    const { count: batchRowCount } = await db.from("pnl_period_answer_rows").select("batch_id", { count: "exact", head: true }).eq("batch_id", batchId)
    ok("batch rows = swept rows (reconciled)", batchRowCount === sweep.swept)
    const { data: tele } = await db.from("action_log").select("details").eq("action_type", "ai_categorization_override").eq("record_id", WS)
    ok("telemetry logged for the 4 flipped ai:high rows", (tele ?? []).some((t: { details: { batch_id?: string; count?: number } }) => t.details?.batch_id === batchId && t.details?.count === 4))

    const rulesAfter = (await db.from("bank_categorization_rules").select("id", { count: "exact", head: true }).eq("workspace_id", WS)).count ?? 0
    ok("ZERO learned rules from the period answer", rulesAfter === rulesBefore)

    // ---- duplicate submit: empty recomputed set → 409, no orphan header ----
    res = await http(`/api/tools/pnl/${WS}/period-answer`, { method: "POST", body: body() })
    const { count: hdrCount } = await db.from("pnl_period_answers").select("id", { count: "exact", head: true }).eq("workspace_id", WS)
    ok("duplicate submit → 409, still exactly one header", res.status === 409 && hdrCount === 1)

    // ---- GET after sweep: card gone, attestation present ----
    const view2 = await (await http(`/api/tools/pnl/${WS}`)).json()
    ok("GET: answered period no longer renders a card", !(view2.periods ?? []).some((p: { primary: string }) => p.primary === "PT"))
    ok("GET: attestation line present", (view2.period_answers ?? []).length === 1)

    // ---- re-answer one swept row, then undo ----
    const reanswered = a.find(r => r.description === "Glovo 0A")
    const { data: reRow } = await db.from("pnl_workspace_transactions").select("id").eq("workspace_id", WS).eq("description", "Glovo 0A").single()
    ok("(setup) picked a swept row to re-answer", !!reanswered && !!reRow)
    await http(`/api/tools/pnl/${WS}/answer`, { method: "POST", body: JSON.stringify({ transaction_ids: [reRow!.id], answer: "business_expense" }) })

    res = await http(`/api/tools/pnl/${WS}/period-answer/undo`, { method: "POST", body: JSON.stringify({ batch_id: batchId }) })
    const undo = await res.json()
    ok("undo 200", res.status === 200, JSON.stringify(undo))
    ok("undo: skipped the re-answered row", undo.skipped_reanswered === 1 && undo.restored === sweep.swept - 1)
    const { data: restored } = await db.from("pnl_workspace_transactions")
      .select("description, category, notes, ai_bucket").eq("workspace_id", WS)
    const r2 = (restored ?? []) as Array<{ description: string; category: string; notes: string | null; ai_bucket: string | null }>
    ok("undo: ai:high rows restored EXACTLY (category expense + version-stamped notes)", r2.filter(r => r.description.includes("hotel run")).every(r => r.category === "expense" && r.notes === "ai:high@v2"))
    ok("undo: NULL-notes rows back to uncategorized with null notes", r2.filter(r => r.description.match(/^Glovo \dB$/)).every(r => r.category === "uncategorized" && r.notes === null))
    ok("undo: re-answered row kept its new manual answer", r2.find(r => r.description === "Glovo 0A")?.category === "expense")

    res = await http(`/api/tools/pnl/${WS}/period-answer/undo`, { method: "POST", body: JSON.stringify({ batch_id: batchId }) })
    ok("double undo → 409", res.status === 409)

    // ---- unauthenticated call is rejected ----
    const bare = await fetch(`${BASE}/api/tools/pnl/${WS}`, { redirect: "manual" })
    ok("unauthenticated GET rejected", bare.status === 403 || bare.status === 307 || bare.status === 401)
  } finally {
    await db.from("pnl_workspaces").delete().eq("id", WS) // cascades tx + batches
    await db.auth.admin.deleteUser(userId)
    console.log("cleanup: workspace + temp user deleted")
  }

  console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`)
  if (fail > 0) process.exit(1)
}

main().catch(e => { console.error("QA FAILED:", e); process.exit(1) })
