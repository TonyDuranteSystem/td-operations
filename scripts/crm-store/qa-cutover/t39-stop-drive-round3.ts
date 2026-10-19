/* eslint-disable no-console, no-restricted-syntax -- a SANDBOX QA script inserts QA Test fixture rows */
/**
 * QA t39 — Stop Drive slice S1c, round 3 (dev job 264bb882). SANDBOX only, real database + storage, Drive off.
 *   W — the sweep window with 250 unfilled shells + used-up alerted rows + 1 real row: the real row is found;
 *   A — the archive job files a storage-first submission into its storage, sets the marker, the row leaves the window for good
 *       (filed vs unfiled);
 *   R — tax review run TWICE: the corrections are applied once (one job), the second run only marks the form reviewed;
 *   C — a person-only closure form is filed in the person's storage and may be reviewed.
 *   QA_ENV_FILE=<sandbox .env.local> npx tsx scripts/crm-store/qa-cutover/t39-stop-drive-round3.ts
 */
import { config } from "dotenv"
import { check, summary } from "./qa-http"
config({ path: process.env.QA_ENV_FILE ?? ".env.local" })

const UX = "30c2cd96-03e4-43cf-9536-81d961b18b1d" // Uxio Test LLC — real storage owner

async function main() {
  if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  delete process.env.GOOGLE_DRIVE_LIVE
  process.env.GOOGLE_SA_KEY = ""
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const sb = supabaseAdmin as unknown as { from: (t: string) => any } // eslint-disable-line @typescript-eslint/no-explicit-any
  const { readSweepWindow } = await import("../../../lib/archive/skip-no-drive-folder")
  const { archiveTaxSubmission } = await import("../../../lib/tax/archive-submission")
  const { approveAndApplyTaxReview } = await import("../../../lib/operations/tax-review")
  const { fileClosureSubmission } = await import("../../../lib/crm-store/save-account-form")
  const tag = `${Date.now()}`
  const REAL = "status.in.(completed,reviewed),review_status.not.is.null"
  const CUTOFF = "2026-07-24T00:00:00Z"
  const created: string[] = []

  // ── W: 250 shells + 2 used-up-and-alerted + 1 real (all oldest-first BEHIND the shells) ──
  const shell = (i: number) => ({ account_id: UX, token: `qa-t39-${tag}-s${i}`, tax_year: 3000 + i, entity_type: "SMLLC", status: "pending", created_at: "2026-08-01T00:00:00Z" })
  for (let i = 0; i < 250; i += 50) {
    const ins = await sb.from("tax_return_submissions").insert(Array.from({ length: 50 }, (_, k) => shell(i + k))).select("id")
    if (ins.error) throw new Error(`shell insert: ${ins.error.message}`)
    created.push(...ins.data.map((r: { id: string }) => r.id))
  }
  const exhausted = await sb.from("tax_return_submissions").insert([0, 1].map((k) => ({ account_id: UX, token: `qa-t39-${tag}-x${k}`, tax_year: 3500 + k, entity_type: "SMLLC", status: "completed", created_at: "2026-08-02T00:00:00Z", drive_archive_meta: { attempts: 5, sweep_alerted: true } }))).select("id")
  if (exhausted.error) throw new Error(`exhausted insert: ${exhausted.error.message}`)
  created.push(...exhausted.data.map((r: { id: string }) => r.id))
  const real = await sb.from("tax_return_submissions").insert({ account_id: UX, token: `qa-t39-${tag}-real`, tax_year: 2088, entity_type: "SMLLC", status: "completed", submitted_data: { note: `QA Test ${tag}` }, upload_paths: [], created_at: "2026-09-01T00:00:00Z" }).select("id").single()
  if (real.error) throw new Error(`real insert: ${real.error.message}`)
  created.push(real.data.id)
  const realId = real.data.id as string

  const w = await readSweepWindow<{ id: string; account_id: string }>("tax_return_submissions", "id, account_id, status, review_status, created_at, drive_archived_at, drive_archive_meta", { cutoffIso: CUTOFF, realFilter: REAL })
  const ids = new Set(w.candidates.map((r) => r.id))
  check("W1 250 unfilled shells in front of 1 real row: the real row IS in the window (the window is 200)", !w.readError && ids.has(realId), JSON.stringify({ err: w.readError, n: w.candidates.length }))
  check("W2 not one shell is in the window", !created.slice(0, 250).some((id) => ids.has(id)))
  check("W3 used-up rows whose one alert already fired are not in the window", !exhausted.data.some((r: { id: string }) => ids.has(r.id)))

  // ── A: archive job files a storage-first submission, marker set, row leaves the window ──
  const a = await archiveTaxSubmission(realId)
  const { data: after } = await sb.from("tax_return_submissions").select("drive_archived_at, drive_archive_meta").eq("id", realId).maybeSingle()
  check("A1 the archive job files it into the company's storage and sets the marker", a.status === "archived" && !!after?.drive_archived_at && after.drive_archive_meta?.filed_in === "storage", JSON.stringify({ a, meta: after?.drive_archive_meta }))
  const w2 = await readSweepWindow<{ id: string }>("tax_return_submissions", "id, account_id, status, review_status, created_at, drive_archived_at, drive_archive_meta", { cutoffIso: CUTOFF, realFilter: REAL })
  check("A2 once filed, the row is OUT of the window for good (nothing to alarm about, nothing to re-run)", !w2.candidates.some((r) => r.id === realId))
  check("A3 filing it again is a no-op", (await archiveTaxSubmission(realId)).status === "already_archived")

  // ── R: tax review twice ──
  const rv = await sb.from("tax_return_submissions").insert({ account_id: UX, token: `qa-t39-${tag}-rv`, tax_year: 2089, entity_type: "SMLLC", status: "completed", submitted_data: {}, upload_paths: [], created_at: "2026-09-02T00:00:00Z" }).select("id").single()
  if (rv.error) throw new Error(`review insert: ${rv.error.message}`)
  created.push(rv.data.id)
  const r1 = await approveAndApplyTaxReview({ submission_id: rv.data.id, actor: "qa-t39", leaveUnreviewed: true })
  const { data: jobs1 } = await sb.from("job_queue").select("id, status, payload").eq("related_entity_id", rv.data.id).eq("job_type", "tax_form_setup")
  // keep the sandbox worker away from this QA job: it stands for "the first run already did its work"
  await sb.from("job_queue").update({ status: "completed" }).eq("related_entity_id", rv.data.id)
  const { data: sub1 } = await sb.from("tax_return_submissions").select("reviewed_at, status").eq("id", rv.data.id).maybeSingle()
  check("R1 first run: ONE job enqueued (marked review_apply + leave_unreviewed), form left unreviewed", r1.ok && (jobs1 ?? []).length === 1 && jobs1[0].payload.review_apply === true && jobs1[0].payload.leave_unreviewed === true && !sub1?.reviewed_at, JSON.stringify({ r1, jobs: (jobs1 ?? []).length, reviewed: sub1?.reviewed_at }))
  const r2 = await approveAndApplyTaxReview({ submission_id: rv.data.id, actor: "qa-t39" })
  const { data: jobs2 } = await sb.from("job_queue").select("id").eq("related_entity_id", rv.data.id).eq("job_type", "tax_form_setup")
  const { data: sub2 } = await sb.from("tax_return_submissions").select("reviewed_at, status").eq("id", rv.data.id).maybeSingle()
  check("R2 second run: NOTHING enqueued again (no reset, no second email, no overwrite) — it only marks the form reviewed", r2.ok && r2.correctionsAlreadyApplied === true && (jobs2 ?? []).length === 1 && !!sub2?.reviewed_at && sub2.status === "reviewed", JSON.stringify({ r2, jobs: (jobs2 ?? []).length, sub2 }))
  const r3 = await approveAndApplyTaxReview({ submission_id: rv.data.id, actor: "qa-t39" })
  check("R3 a third run is the existing 'already reviewed' no-op", r3.ok && r3.alreadyApplied === true)

  // ── C: person-only closure ──
  const ct = await sb.from("contacts").insert({ full_name: `QA Test Closure Person ${tag}`, email: `qa-t39-${tag}@example.com` }).select("id").single()
  const c1 = await fileClosureSubmission({ token: `qa-t39-${tag}-c`, account_id: null, contact_id: ct.data.id, upload_paths: [], completed_at: new Date().toISOString() }, { client_name: `QA Test ${tag}` }, "QA Test", "qa/t39")
  check("C1 a closure form with a PERSON but no company is filed in the person's storage and may be reviewed", c1.ok === true && c1.lines.join(" ").includes("Data summary saved"), JSON.stringify(c1))
  const c2 = await fileClosureSubmission({ token: `qa-t39-${tag}-c2`, account_id: null, contact_id: null, upload_paths: [], completed_at: null }, {}, "QA Test", "qa/t39")
  check("C2 a closure form with neither company nor person is never stuck: reviewable, with a clear note", c2.ok === true && c2.lines.join(" ").includes("stay on the submission"), JSON.stringify(c2))

  // ── round 4: a company being MOVED is 'try again' (decided before anything changes); the contact variant of the one rule ──
  const { receiveVerdictFor, noStorageDecisionForContact } = await import("../../../lib/crm-store/no-storage")
  const { data: tc } = await sb.from("accounts").select("id").eq("company_name", "QA Test Co LLC").limit(1).maybeSingle()
  const run = await sb.from("store_import_runs").insert({ account_id: tc.id, mode: "move", status: "moving" }).select("id").single()
  const mv = await receiveVerdictFor(tc.id)
  check("M1 a company mid-move: the pre-check says 'try again in a few minutes' (so the lease row etc. are never touched)", mv.ok === false && mv.reason === "moving" && mv.sentence.includes("try again in a few minutes"), JSON.stringify(mv))
  if (run.data) await sb.from("store_import_runs").delete().eq("id", run.data.id)
  const idle = await receiveVerdictFor(tc.id)
  check("M2 the same company when idle (Active, no folder, no storage): refused with the true reason", idle.ok === false && idle.reason === "no_folder", JSON.stringify(idle))
  const cd = await noStorageDecisionForContact(ct.data.id)
  check("M3 the contact variant of the one rule: a person with their own storage is never given a Drive folder", cd.route === "refuse", JSON.stringify(cd))

  // ── round 5 ──
  // P: two near-simultaneous review clicks → exactly ONE apply job (the database refuses the second)
  const pr = await sb.from("tax_return_submissions").insert({ account_id: UX, token: `qa-t39-${tag}-par`, tax_year: 2090, entity_type: "SMLLC", status: "completed", submitted_data: {}, upload_paths: [], created_at: "2026-09-03T00:00:00Z" }).select("id").single()
  if (pr.error) throw new Error(`parallel insert: ${pr.error.message}`)
  created.push(pr.data.id)
  const par = await Promise.all([1, 2, 3].map(() => approveAndApplyTaxReview({ submission_id: pr.data.id, actor: "qa-t39-par", leaveUnreviewed: true })))
  const { data: pjobs } = await sb.from("job_queue").select("id").eq("related_entity_id", pr.data.id).eq("job_type", "tax_form_setup")
  await sb.from("job_queue").update({ status: "completed" }).eq("related_entity_id", pr.data.id)
  check("P1 three simultaneous review clicks → exactly ONE apply job, every click answers ok with the same job", par.every((x) => x.ok) && (pjobs ?? []).length === 1 && new Set(par.map((x) => x.job_id)).size === 1, JSON.stringify({ n: (pjobs ?? []).length, res: par.map((x) => ({ ok: x.ok, job: x.job_id, again: x.correctionsAlreadyApplied })) }))

  // MM: the alert flag survives an attempt record and vice versa (atomic merge)
  const { mergeArchiveMeta } = await import("../../../lib/archive/meta-merge")
  await sb.from("tax_return_submissions").update({ drive_archive_meta: { attempts: 5 } }).eq("id", pr.data.id)
  await Promise.all([
    mergeArchiveMeta("tax_return_submissions", pr.data.id, { sweep_alerted: true }),
    mergeArchiveMeta("tax_return_submissions", pr.data.id, { last_error: "x", attempts: 6 }),
    mergeArchiveMeta("tax_return_submissions", pr.data.id, { filed_in: "storage" }),
  ])
  const { data: mm } = await sb.from("tax_return_submissions").select("drive_archive_meta").eq("id", pr.data.id).maybeSingle()
  check("MM1 three parallel meta writes keep ALL their keys (the sweep's alert flag is never dropped)", mm?.drive_archive_meta?.sweep_alerted === true && mm.drive_archive_meta.attempts === 6 && mm.drive_archive_meta.filed_in === "storage" && mm.drive_archive_meta.last_error === "x", JSON.stringify(mm))

  // F: a Closed company's submission is not in the window but is counted as left alone (the PR2 QA company is Cancelled)
  const { data: canc } = await sb.from("accounts").select("id").in("status", ["Closed", "Cancelled"]).limit(1).maybeSingle()
  if (canc) {
    const cs = await sb.from("tax_return_submissions").insert({ account_id: canc.id, token: `qa-t39-${tag}-fin`, tax_year: 2091, entity_type: "SMLLC", status: "completed", submitted_data: {}, upload_paths: [], created_at: "2026-09-04T00:00:00Z" }).select("id").single()
    created.push(cs.data.id)
    const wo = await readSweepWindow<{ id: string }>("tax_return_submissions", "id, account_id", { cutoffIso: CUTOFF, realFilter: REAL })
    check("F1 a submission of a Closed / Cancelled company is not in the window, but is counted as left alone", !wo.readError && !wo.candidates.some((r) => r.id === cs.data.id) && wo.skippedFinished >= 1, JSON.stringify({ err: wo.readError, n: wo.candidates.length, skipped: wo.skippedFinished }))
  } else console.log("   (skipped F1: no Closed/Cancelled company in the sandbox)")

  // N: a real tax row with NO company stays in the window (it is loud, not silent)
  const nc = await sb.from("tax_return_submissions").insert({ token: `qa-t39-${tag}-noco`, tax_year: 2092, entity_type: "SMLLC", status: "completed", submitted_data: {}, upload_paths: [], created_at: "2026-09-05T00:00:00Z" }).select("id").single()
  if (!nc.error) {
    created.push(nc.data.id)
    const wn = await readSweepWindow<{ id: string }>("tax_return_submissions", "id, account_id", { cutoffIso: CUTOFF, realFilter: REAL })
    check("N1 a completed tax row with NO company stays in the window (decided loudly by the sweep, never skipped quietly)", wn.candidates.some((r) => r.id === nc.data.id))
  } else console.log("   (skipped N1:", nc.error.message, ")")

  // cleanup
  await sb.from("job_queue").delete().in("related_entity_id", created)
  await sb.from("tax_return_submissions").delete().in("id", created)
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
