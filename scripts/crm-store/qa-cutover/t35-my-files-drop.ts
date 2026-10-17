/* eslint-disable no-console */
/**
 * QA t35 — the My files DROP (dev job 1ed4fb18). SANDBOX only. Calls the real server function against the sandbox database
 * and storage: a save lands in the owner's private My files › From Claude; a repeat makes no copy; the refusals hold.
 *   npx tsx scripts/crm-store/qa-cutover/t35-my-files-drop.ts
 */
import { config } from "dotenv"
import { check, summary } from "./qa-http"
config({ path: ".env.local" })

async function main() {
  if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  process.env.MY_FILES_DROP_ENABLED = "1"
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const { saveToMyFilesDrop } = await import("../../../lib/crm-store/my-files-drop")
  const { ownersAreaUserId } = await import("../../../lib/crm-store/structure")
  const sb = supabaseAdmin as unknown as { from: (t: string) => any; rpc: (f: string, a: unknown) => Promise<any> } // eslint-disable-line @typescript-eslint/no-explicit-any
  const caller = { method: "static", email: "antonio.durante@tonydurante.us" }
  const tag = `${Date.now()}`

  const uid = await ownersAreaUserId()
  const { data: owner } = await sb.from("store_owners").select("id").eq("kind", "private").eq("private_user_id", uid).maybeSingle()
  const { data: others } = await sb.from("store_owners").select("id").eq("kind", "private").neq("id", owner.id)
  const countAll = async (ids: string[]) => (await sb.from("store_files").select("id", { count: "exact", head: true }).in("owner_id", ids)).count as number
  const othersBefore = await countAll(others.map((o: { id: string }) => o.id))
  const keyCount = async (k: string) => (await sb.from("store_files").select("id", { count: "exact", head: true }).eq("caller_key", `my-files-drop:${k}`)).count as number

  // D1 first save
  const key1 = `qa-${tag}-a`
  const r1 = await saveToMyFilesDrop({ name: `QA plan ${tag}.md`, text: "# QA plan\n- one\n", caller_key: key1 }, caller)
  check("D1 a save is created and the path is in My files › From Claude", r1.ok && r1.status === "created" && r1.path.startsWith("My files › From Claude › "), JSON.stringify(r1))
  const { data: f1 } = await sb.from("store_files").select("id, owner_id, published, folder_id, state").eq("caller_key", `my-files-drop:${key1}`).maybeSingle()
  check("D2 it is in the OWNER's private My files, hidden, live", f1?.owner_id === owner.id && f1?.published === false && f1?.state === "live", JSON.stringify(f1))
  const { data: ev } = await sb.from("store_events").select("event, details").eq("file_id", f1.id).eq("event", "created")
  check("D3 the audit row exists (store_events created, with the key)", (ev ?? []).length === 1 && ev[0].details.caller_key === `my-files-drop:${key1}`)
  const { data: al } = await sb.from("action_log").select("details").eq("record_id", f1.id)
  check("D4 the action log has who/how (auth method + email + sha)", (al ?? []).some((a: { details: Record<string, string> }) => a.details.auth_method === "static" && a.details.caller_email === caller.email && !!a.details.sha256))
  const { data: fx } = await sb.from("store_file_facts").select("key, value").eq("file_id", f1.id)
  check("D5 the file carries the 'untrusted AI content' provenance fact", (fx ?? []).some((x: { key: string; value: string }) => x.key === "saved_by" && /untrusted/.test(x.value)))

  // D6 same key, same content = no second copy
  const r2 = await saveToMyFilesDrop({ name: `QA plan ${tag}.md`, text: "# QA plan\n- one\n", caller_key: key1 }, caller)
  check("D6 same key + same content: 'unchanged' (no path shown), still ONE file", r2.ok && r2.status === "unchanged" && !r2.path.includes("From Claude") && (await keyCount(key1)) === 1, JSON.stringify(r2))
  // D7 same key, different content = refused, nothing changed
  const r3 = await saveToMyFilesDrop({ name: `QA plan ${tag}.md`, text: "# CHANGED\n", caller_key: key1 }, caller)
  const { data: vers } = await sb.from("store_file_versions").select("id").eq("file_id", f1.id)
  check("D7 same key + different content: refused, still ONE version", !r3.ok && (vers ?? []).length === 1, JSON.stringify(r3))
  // D8 derived key (none given): a repeat is a no-op
  const a = await saveToMyFilesDrop({ name: `QA auto ${tag}.txt`, text: "auto key content" }, caller)
  const b = await saveToMyFilesDrop({ name: `QA auto ${tag}.txt`, text: "auto key content" }, caller)
  check("D8 no caller_key: the repeat is 'unchanged'", a.ok && b.ok && a.status === "created" && b.status === "unchanged")
  // D9 name clash under a different key -> " (2)", the first file untouched
  const c = await saveToMyFilesDrop({ name: `QA plan ${tag}.md`, text: "different file, same name", caller_key: `${key1}-clash` }, caller)
  check("D9 a name clash is saved as (2); nothing replaced", c.ok && c.name === `QA plan ${tag} (2).md`, JSON.stringify(c))
  // D10 subfolder
  const d = await saveToMyFilesDrop({ name: `QA sub ${tag}.csv`, text: "a,b\n1,-2\n", subfolder: "QA Drop/Plans" }, caller)
  check("D10 a subfolder is created below From Claude", d.ok && d.path.includes("From Claude › QA Drop › Plans › "), JSON.stringify(d))
  // D11 refusals
  const bad: Array<[string, Record<string, unknown>]> = [
    ["traversal", { name: "x.md", text: "a", subfolder: "../../Business" }],
    ["html", { name: "x.html", text: "<script>1</script>" }],
    ["svg", { name: "x.svg", text: "<svg/>" }],
    ["macro doc", { name: "x.doc", content_base64: Buffer.from("zzzz").toString("base64") }],
    ["fake pdf", { name: "x.pdf", text: "not a pdf" }],
    ["too big", { name: "x.txt", text: "a".repeat(3 * 1024 * 1024 + 1) }],
    ["formula csv", { name: "x.csv", text: "a\n=HYPERLINK(\"http://x\")" }],
    ["spoof name", { name: "x‮gnp.pdf", text: "a" }],
  ]
  for (const [label, input] of bad) {
    const r = await saveToMyFilesDrop(input as never, caller)
    check(`D11 refused: ${label}`, !r.ok, JSON.stringify(r).slice(0, 160))
  }
  // D12 switch off
  process.env.MY_FILES_DROP_ENABLED = "0"
  const off = await saveToMyFilesDrop({ name: "x.md", text: "a" }, caller)
  check("D12 switched off: refused", !off.ok)
  process.env.MY_FILES_DROP_ENABLED = "1"

  // D13 five simultaneous saves with ONE key and different content -> exactly one file, one version, one winner
  const raceKey = `qa-${tag}-race`
  const race = await Promise.all([1, 2, 3, 4, 5].map((i) => saveToMyFilesDrop({ name: `QA race ${tag}.md`, text: `content ${i}`, caller_key: raceKey }, caller)))
  const { data: rf } = await sb.from("store_files").select("id").eq("caller_key", `my-files-drop:${raceKey}`)
  const { data: rv } = await sb.from("store_file_versions").select("id").eq("file_id", rf?.[0]?.id)
  check("D13 5 racing saves, one key: one file, ONE version, exactly one success", (rf ?? []).length === 1 && (rv ?? []).length === 1 && race.filter((x) => x.ok && x.status === "created").length === 1, `${race.map((x) => (x.ok ? x.status : "refused")).join(",")} files=${rf?.length} versions=${rv?.length}`)

  // D14 trashed file: the same key does not pretend to save
  const tr = await sb.rpc("store_trash_file", { p_file_id: f1.id, p_actor: uid, p_reason: "QA t35" })
  if (tr.error) console.log("trash rpc error:", JSON.stringify(tr.error))
  const t = await saveToMyFilesDrop({ name: `QA plan ${tag}.md`, text: "# QA plan\n- one\n", caller_key: key1 }, caller)
  check("D14 a deleted file's key is refused with a clear message", !t.ok && /deleted/.test(t.error), JSON.stringify(t))

  // D15 the drop folder moved INTO 'Shared with staff': the next save must NOT land under it
  const { data: setting } = await sb.from("app_settings").select("value").eq("key", "my_files_drop_folder_id").maybeSingle()
  const dropId = setting.value as string
  const { data: share } = await sb.from("store_folders").select("id").eq("owner_id", owner.id).eq("kind", "staff_share").is("trashed_at", null).maybeSingle()
  const { data: before } = await sb.from("store_folders").select("parent_id").eq("id", dropId).maybeSingle()
  // tidy a leftover from an earlier run, then move the real drop folder (renamed so it cannot clash) into the share
  const { data: left } = await sb.from("store_folders").select("id").eq("owner_id", owner.id).eq("parent_id", share.id).ilike("name", "From Claude%").is("trashed_at", null)
  for (const l of left ?? []) await sb.rpc("store_trash_folder", { p_folder_id: l.id, p_actor: uid, p_reason: "QA t35 tidy" })
  const mv = await sb.from("store_folders").update({ parent_id: share.id, name: `QA old drop ${tag}`, name_key: `qa old drop ${tag}` }).eq("id", dropId)
  const e = await saveToMyFilesDrop({ name: `QA after move ${tag}.md`, text: "after the move" }, caller)
  const { data: setting2 } = await sb.from("app_settings").select("value").eq("key", "my_files_drop_folder_id").maybeSingle()
  const { data: placed } = await sb.from("store_files").select("folder_id").eq("name", `QA after move ${tag}.md`).eq("owner_id", owner.id).maybeSingle()
  check("D15 drop folder moved into 'Shared with staff': a fresh folder is made, the file is NOT under the share", !mv.error && e.ok && setting2.value !== dropId && placed?.folder_id !== dropId, `${JSON.stringify(mv.error)} ${JSON.stringify(e)}`)
  // put it back, so the sandbox stays tidy
  await sb.from("store_folders").update({ parent_id: before.parent_id }).eq("id", dropId)
  await sb.rpc("store_trash_folder", { p_folder_id: dropId, p_actor: uid, p_reason: "QA t35 tidy" })

  // D17 the rate-limit counter really sees the drops (the database filter matches)
  const since = new Date(Date.now() - 24 * 3600_000).toISOString()
  const { data: seen } = await sb.from("store_events").select("id").eq("event", "created").eq("owner_id", owner.id).like("details->>caller_key", "my-files-drop:%").gte("occurred_at", since)
  check("D17 the rate-limit query finds today's drops", (seen ?? []).length >= 6, `${(seen ?? []).length}`)
  // D16 nothing else changed: no other private area got a file
  const othersAfter = await countAll(others.map((o: { id: string }) => o.id))
  check("D16 no other private area received anything", othersAfter === othersBefore, `${othersBefore} -> ${othersAfter}`)

  summary(); process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
