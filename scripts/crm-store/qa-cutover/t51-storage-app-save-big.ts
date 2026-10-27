/* eslint-disable no-console */
/**
 * Storage Mac app (dev job 1992a087): saving a BIG file (Zoom videos, up to 2 GB) from a Mac. SANDBOX only. Real database + real storage + the real
 * route handlers + the real background-job handler (run for OUR job only, so no other session's job is touched).
 * Run: npx tsx scripts/crm-store/qa-cutover/t51-storage-app-save-big.ts <path of a big test file, e.g. 800 MB>
 * Proves: a file over 150 MB is accepted (slot), uploaded, answered "pending" (202) and registered by the job; asking again never queues a
 * second job; the saved file is byte-exact (size + sha-256), hidden, one file for the key; a retry of the slot says already saved; a lost answer
 * (bytes already uploaded) is not uploaded twice; an interrupted upload leaves nothing and can be started again; a job that gave up is told
 * plainly, its hourly share given back and a fresh slot offered; 3 GB is refused; a new VERSION of a file stays capped at 150 MB.
 */
import { config } from "dotenv"
import { randomBytes, createHash, randomUUID } from "crypto"
import { createReadStream, statSync } from "fs"
import { execSync } from "child_process"
import { NextRequest } from "next/server"
import { check, summary } from "./qa-http"
config({ path: ".env.local" })

const REDIRECT = "http://127.0.0.1:53682/cb"
const verifier = randomBytes(48).toString("base64url")
const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url")

async function sha256OfFile(path: string): Promise<string> {
  const h = createHash("sha256")
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer)
  return h.digest("hex")
}

async function main() {
  const bigFile = process.argv[2]
  if (!bigFile) throw new Error("give the path of a big test file")
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("xjcxlmlpeywtwkhstjlw")) throw new Error("REFUSED: not the sandbox")
  const size = statSync(bigFile).size
  const wantSha = await sha256OfFile(bigFile)
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const admin = supabaseAdmin as any // eslint-disable-line @typescript-eslint/no-explicit-any
  const A = await import("../../../lib/storage-app/device-auth")
  const { trashFile } = await import("../../../lib/crm-store/folders")
  const { getJobHandler } = await import("../../../lib/jobs/registry")
  const { completeJob } = await import("../../../lib/jobs/queue")
  const slotRoute = (await import("../../../app/api/storage-app/upload-slot/route")).POST
  const saveRoute = (await import("../../../app/api/storage-app/save/route")).POST
  const stamp = Date.now()

  const { data: made, error } = await admin.auth.admin.createUser({ email: `qa-sa-big-${stamp}@sandbox.td`, password: randomBytes(18).toString("base64url"), email_confirm: true, app_metadata: { role: "team", mfa_exempt: true } })
  if (error || !made?.user) throw new Error(`could not create the test login: ${error?.message}`)
  const user = made.user as { id: string; email: string }
  const { data: priorList } = await admin.from("app_settings").select("value").eq("key", "storage_app_allowed_emails").maybeSingle()
  await admin.from("app_settings").upsert({ key: "storage_app_allowed_emails", value: [...(Array.isArray(priorList?.value) ? priorList.value : []), user.email], updated_at: new Date().toISOString() })
  const { data: adminUsers } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
  const qa = (adminUsers?.users ?? []).find((u: { app_metadata?: { role?: string } }) => u.app_metadata?.role === "admin")
  const ACTOR = { id: qa.id as string, app_metadata: { role: "admin" } } as never
  const savedIds: string[] = []
  const stagedLeft: string[] = []

  const call = async (route: (r: NextRequest) => Promise<Response>, token: string, path: string, body?: unknown) => {
    const r = await route(new NextRequest(`http://localhost${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }))
    return { status: r.status, body: await r.json().catch(() => null) as any } // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  const slot = (token: string, o: Record<string, unknown>) => call(slotRoute as never, token, "/api/storage-app/upload-slot", o)
  const save = (token: string, o: Record<string, unknown>) => call(saveRoute as never, token, "/api/storage-app/save", o)
  // the same kind of PUT the Mac makes (a streamed upload from the file on disk)
  const put = (url: string, maxSeconds?: number) => execSync(`curl -sS -o /dev/null -w "%{http_code}" ${maxSeconds ? `--max-time ${maxSeconds}` : ""} -X PUT -H "Content-Type: video/mp4" -H "x-upsert: false" --data-binary @${JSON.stringify(bigFile)} "${url}"`, { maxBuffer: 1e7, stdio: ["ignore", "pipe", "ignore"] }).toString()
  const jobsFor = async (intentId: string) => ((await admin.from("job_queue").select("id, status, attempts").eq("job_type", "crm_store_register_upload").eq("related_entity_id", intentId)).data ?? []) as Array<{ id: string; status: string; attempts: number }>
  // what the worker does for ONE job: run its handler, then mark it completed (our job only)
  const runJob = async (jobId: string) => {
    const { data: job } = await admin.from("job_queue").select("*").eq("id", jobId).single()
    await admin.from("job_queue").update({ status: "processing", started_at: new Date().toISOString() }).eq("id", jobId)
    const result = await getJobHandler(job.job_type)!({ ...job, status: "processing" })
    await completeJob(jobId, result)
  }

  try {
    const code = await A.createAuthCode({ userId: user.id, deviceName: "QA big Mac", codeChallenge: challenge, redirectUri: REDIRECT })
    const t = await A.exchangeCode({ code, codeVerifier: verifier, redirectUri: REDIRECT })
    const { data: biz } = await admin.from("store_owners").select("id").eq("kind", "business").limit(1).maybeSingle()
    const { data: kids } = await admin.from("store_folders").select("id").eq("owner_id", biz.id).eq("kind", "custom").is("trashed_at", null).limit(1)
    const folderId = kids[0].id as string
    const ownerId = biz.id as string
    const mb = Math.round(size / 1048576)
    console.log(`test file: ${mb} MB, sha-256 ${wantSha.slice(0, 12)}…`)

    // 1 — the slot accepts a big file; the upload and the save answer "pending"
    const key = randomUUID()
    const name = `QA zoom call ${stamp}.mp4`
    const s1 = await slot(t.access_token, { ownerId, folderId, name, size, mimeType: "video/mp4", itemKey: key })
    check(`1 a slot is given for a ${mb} MB file`, s1.status === 200 && typeof s1.body?.uploadUrl === "string" && s1.body?.maxBytes === 2048 * 1048576, `status ${s1.status} ${JSON.stringify(s1.body)}`.slice(0, 200))
    let t0 = Date.now()
    check("2 the bytes go straight to storage", put(s1.body.uploadUrl) === "200", "")
    console.log(`   upload took ${((Date.now() - t0) / 1000).toFixed(1)} s`)
    const sv = await save(t.access_token, { intentId: s1.body.intentId, itemKey: key })
    check("3 save answers 202 pending (not a 500, not a 413)", sv.status === 202 && sv.body?.pending === true, `status ${sv.status} ${JSON.stringify(sv.body)}`)
    const sv2 = await save(t.access_token, { intentId: s1.body.intentId, itemKey: key })
    check("4 asking again is still 'pending' and queues NO second job", sv2.status === 202 && (await jobsFor(s1.body.intentId)).length === 1, `status ${sv2.status} jobs ${(await jobsFor(s1.body.intentId)).length}`)
    const slotAgain = await slot(t.access_token, { ownerId, folderId, name, size, mimeType: "video/mp4", itemKey: key })
    check("5 a Finder retry of the slot while it registers says 'already uploaded' (no second upload)", slotAgain.status === 200 && slotAgain.body?.alreadyUploaded === true && !slotAgain.body?.uploadUrl && slotAgain.body?.intentId === s1.body.intentId, JSON.stringify(slotAgain.body))

    // 2 — the background job registers it
    const jobs = await jobsFor(s1.body.intentId)
    t0 = Date.now()
    await runJob(jobs[0].id)
    console.log(`   registering took ${((Date.now() - t0) / 1000).toFixed(1)} s`)
    const done = await save(t.access_token, { intentId: s1.body.intentId, itemKey: key })
    check("6 after the job, save answers 200 with the file", done.status === 200 && typeof done.body?.fileId === "string" && done.body?.name === name, JSON.stringify(done.body))
    if (done.body?.fileId) savedIds.push(done.body.fileId)
    const { data: row } = await admin.from("store_files").select("id, folder_id, published, document_type, state, caller_key, current_version_id").eq("id", done.body.fileId).single()
    const { data: ver } = await admin.from("store_file_versions").select("sha256, size_bytes, version_no, created_by").eq("id", row.current_version_id).single()
    check("7 stored byte-exact (size + sha-256), version 1, in the chosen folder", ver.sha256 === wantSha && Number(ver.size_bytes) === size && ver.version_no === 1 && row.folder_id === folderId, JSON.stringify(ver))
    check("8 HIDDEN from clients, no document type", row.published === false && row.document_type === null, JSON.stringify(row))
    const { data: copies } = await admin.from("store_files").select("id").eq("folder_id", folderId).eq("caller_key", row.caller_key)
    check("9 exactly one file for the key", (copies ?? []).length === 1, `rows=${(copies ?? []).length}`)
    const again = await slot(t.access_token, { ownerId, folderId, name, size, mimeType: "video/mp4", itemKey: key })
    check("10 asking for the slot after it finished says already saved, same file", again.status === 200 && again.body?.alreadySaved === true && again.body?.fileId === done.body.fileId, JSON.stringify(again.body))
    const sameName = await slot(t.access_token, { ownerId, folderId, name, size, mimeType: "video/mp4", itemKey: randomUUID() })
    check("11 copying the same folder again (another key, same name) → 409 exists, nothing doubled", sameName.status === 409 && sameName.body?.error === "exists", JSON.stringify(sameName.body))

    // 3 — an interrupted upload leaves nothing and can start again
    const key2 = randomUUID()
    const name2 = `QA zoom cut ${stamp}.mp4`
    const c1 = await slot(t.access_token, { ownerId, folderId, name: name2, size, mimeType: "video/mp4", itemKey: key2 })
    let cut = "cut"
    try { cut = put(c1.body.uploadUrl, 2) } catch { cut = "cut" }
    check("12 an upload cut off after 2 seconds does not finish", cut === "cut" || !cut.startsWith("2"), cut)
    const { data: info } = await admin.storage.from("crm-store-staging").info((await admin.from("store_upload_intents").select("staging_path").eq("id", c1.body.intentId).single()).data.staging_path)
    check("13 …and leaves no half file in storage", !info, JSON.stringify(info))
    const c2 = await slot(t.access_token, { ownerId, folderId, name: name2, size, mimeType: "video/mp4", itemKey: key2 })
    check("14 the retry gets the SAME slot with a fresh upload address (not 'already uploaded')", c2.status === 200 && c2.body?.intentId === c1.body.intentId && typeof c2.body?.uploadUrl === "string" && !c2.body?.alreadyUploaded, JSON.stringify(c2.body))
    check("15 the retry uploads fully", put(c2.body.uploadUrl) === "200", "")
    // the answer to the upload was lost: asking for the slot again must not send the bytes twice
    const c3 = await slot(t.access_token, { ownerId, folderId, name: name2, size, mimeType: "video/mp4", itemKey: key2 })
    check("16 the bytes are in: the slot says 'already uploaded'", c3.status === 200 && c3.body?.alreadyUploaded === true && !c3.body?.uploadUrl, JSON.stringify(c3.body))

    // 4 — a job that gave up: told plainly, share given back, fresh slot
    const sv3 = await save(t.access_token, { intentId: c1.body.intentId, itemKey: key2 })
    check("17 save → 202 pending", sv3.status === 202, `status ${sv3.status}`)
    const j2 = await jobsFor(c1.body.intentId)
    await admin.from("job_queue").update({ status: "failed", error: "qa: forced failure", attempts: 3 }).eq("id", j2[0].id)
    const failed = await save(t.access_token, { intentId: c1.body.intentId, itemKey: key2 })
    check("18 a job that gave up → 409 register_failed with plain words", failed.status === 409 && failed.body?.error === "register_failed" && typeof failed.body?.message === "string", JSON.stringify(failed.body))
    const { data: refunds } = await admin.from("store_events").select("details").eq("event", "app_upload_refunded").eq("details->>callerKey", `storage-app:${t.device_id}:${key2}`)
    check("19 the hourly share was given back (size recorded)", (refunds ?? []).length >= 1 && Number(refunds[0].details?.size) >= size, JSON.stringify(refunds))
    const { data: oldSlot } = await admin.from("store_upload_intents").select("consumed_at, staging_path").eq("id", c1.body.intentId).single()
    check("20 the failed slot is closed and its staged bytes removed", !!oldSlot.consumed_at && !(await admin.storage.from("crm-store-staging").info(oldSlot.staging_path)).data, JSON.stringify(oldSlot))
    const fresh = await slot(t.access_token, { ownerId, folderId, name: name2, size, mimeType: "video/mp4", itemKey: key2 })
    check("21 Finder's next try gets a NEW slot and a new address", fresh.status === 200 && fresh.body?.intentId !== c1.body.intentId && typeof fresh.body?.uploadUrl === "string", JSON.stringify(fresh.body))
    stagedLeft.push(fresh.body.intentId)

    // 5 — limits
    const huge = await slot(t.access_token, { ownerId, folderId, name: `QA huge ${stamp}.mp4`, size: 3 * 1024 * 1048576, mimeType: "video/mp4", itemKey: randomUUID() })
    check("22 a 3 GB file → 413 too_big", huge.status === 413 && huge.body?.error === "too_big", JSON.stringify(huge.body))
    const updKey = randomUUID()
    const upd = await slot(t.access_token, { replaceFileId: done.body.fileId, size: 200 * 1048576, mimeType: "video/mp4", itemKey: updKey })
    check("23 a new VERSION of a saved file stays capped at 150 MB → 413", upd.status === 413 && upd.body?.error === "too_big", JSON.stringify(upd.body))
  } finally {
    for (const id of savedIds) await trashFile(ACTOR, id, "qa save big").catch(() => null)
    for (const intentId of stagedLeft) {
      const { data: i } = await admin.from("store_upload_intents").select("staging_path").eq("id", intentId).maybeSingle()
      if (i) await admin.storage.from("crm-store-staging").remove([i.staging_path]).catch(() => null)
      await admin.from("store_upload_intents").update({ consumed_at: new Date().toISOString() }).eq("id", intentId).is("consumed_at", null)
    }
    if (priorList) await admin.from("app_settings").upsert({ key: "storage_app_allowed_emails", value: priorList.value, updated_at: new Date().toISOString() })
    else await admin.from("app_settings").delete().eq("key", "storage_app_allowed_emails")
    await admin.from("storage_app_devices").delete().eq("user_id", user.id)
    await admin.from("storage_app_auth_codes").delete().eq("user_id", user.id)
    await admin.auth.admin.deleteUser(user.id).catch(() => null)
  }
  summary()
}

main().catch((e) => { console.error("FATAL", e); process.exit(1) })
