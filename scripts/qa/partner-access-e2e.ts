/* eslint-disable no-console -- QA harness; console output IS the product */
/**
 * Partner access-log E2E (dev job 5f534ed9, Antonio's order 2026-08-07):
 * create a THROWAWAY partner on the SANDBOX, walk the real partner chain
 * (login → collab page → projects list → brief open → actual file download
 * via the signed URL → chat read + send), then print the access-log rows.
 *
 * All fixtures are throwaway (Clearview rule — nothing mirrors a real
 * client) and deleted at the end. REFUSES to run against production.
 *
 * Run: QA_BASE_URL=https://td-operations-sandbox.vercel.app \
 *        npx tsx --env-file=.env.local scripts/qa/partner-access-e2e.ts
 */
import { createClient as createSb } from "@supabase/supabase-js"
import { supabaseAdmin } from "@/lib/supabase-admin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

const BASE = process.env.QA_BASE_URL ?? "http://localhost:3210"
const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SB_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const REF = new URL(SB_URL).hostname.split(".")[0]
if (REF === "ydzipybqeebtpcvsbtvs") throw new Error("REFUSING to run against PRODUCTION")

let pass = 0
let fail = 0
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name} ${detail}`) }
  else { fail++; console.log(`  ❌ FAIL ${name} ${detail}`) }
}

function sessionCookies(session: unknown): string {
  const raw = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url")
  const name = `sb-${REF}-auth-token`
  if (raw.length <= 3180) return `${name}=${raw}`
  const parts: string[] = []
  for (let i = 0; i * 3180 < raw.length; i++) parts.push(`${name}.${i}=${raw.slice(i * 3180, (i + 1) * 3180)}`)
  return parts.join("; ")
}

async function main() {
  console.log(`\n== PARTNER ACCESS E2E (server ${BASE}, DB ${REF}) ==`)
  const stamp = Date.now()
  const email = `qa-partner-e2e-${stamp}@tonydurante.us`
  const password = `QApt!${Math.random().toString(36).slice(2)}${stamp % 997}`
  const filePath = `wizard/qa-partner-e2e-${stamp}/brand-note.txt`
  const fileContent = `QA partner E2E test file ${stamp}`

  // ── Fixtures (all throwaway). Cleanup is incremental — a failure at ANY
  //    fixture step must not leak the earlier ones (leaked once, fixed). ──
  let contactId: string | undefined
  let partnerId: string | undefined
  let userId: string | undefined
  let fileUploaded = false
  let enrollmentId: string | undefined

  const cleanup = async () => {
    if (partnerId) await db.from("partner_access_log").delete().eq("partner_id", partnerId)
    if (partnerId) { try { await db.from("comm_messages").delete().eq("sender_id", partnerId) } catch { /* best effort */ } }
    if (enrollmentId) await db.from("td_comm_enrollments").delete().eq("id", enrollmentId)
    if (fileUploaded) { try { await supabaseAdmin.storage.from("onboarding-uploads").remove([filePath]) } catch { /* best effort */ } }
    if (userId) { try { await db.auth.admin.deleteUser(userId) } catch { /* best effort */ } }
    if (partnerId) await db.from("client_partners").delete().eq("id", partnerId)
    if (contactId) await db.from("contacts").delete().eq("id", contactId)
  }

  try {
    // QA harness: a throwaway fixture contact created and deleted inside this
    // script. The operations helpers exist for real client writes; this is
    // deliberately not one.
    // eslint-disable-next-line no-restricted-syntax -- throwaway QA fixture, deleted in cleanup
    const { data: contact, error: cErr } = await db.from("contacts")
      .insert({ full_name: "QA Throwaway Partner", email, language: "English" })
      .select("id").single()
    if (cErr) throw new Error(`contact: ${cErr.message}`)
    contactId = contact.id as string

    const { data: partnerRow, error: pErr } = await db.from("client_partners")
      .insert({ contact_id: contactId, partner_name: "QA Throwaway Partner", partner_scope: ["td_communication"], display_title: "QA Partner" })
      .select("id").single()
    if (pErr) throw new Error(`partner: ${pErr.message}`)
    partnerId = partnerRow.id as string

    const { data: authUser, error: uErr } = await db.auth.admin.createUser({
      email, password, email_confirm: true,
      app_metadata: { role: "partner", contact_id: contactId },
    })
    if (uErr) throw new Error(`auth user: ${uErr.message}`)
    userId = authUser.user.id as string

    const up = await supabaseAdmin.storage.from("onboarding-uploads")
      .upload(filePath, Buffer.from(fileContent), { contentType: "text/plain" })
    if (up.error) throw new Error(`upload: ${up.error.message}`)
    fileUploaded = true

    const { data: enr, error: eErr } = await db.from("td_comm_enrollments")
      .insert({
        contact_id: contactId, client_type: "new_brand", package_slug: "qa-fixture",
        status: "enrolled", worker_partner_id: partnerId,
        form_data: { brand_name: "QA Fixture Brand", uploads: [filePath] },
        metadata: {},
      })
      .select("id").single()
    if (eErr) throw new Error(`enrollment: ${eErr.message}`)
    enrollmentId = enr.id as string

    // A foreign enrollment (someone else's) for the negative test.
    const { data: foreign } = await db.from("td_comm_enrollments")
      .select("id").neq("id", enrollmentId).limit(1).single()
    // ── The chain, as the partner ──────────────────────────────────
    const anon = createSb(SB_URL, SB_ANON, { auth: { persistSession: false } })
    const { data: signIn, error: sErr } = await anon.auth.signInWithPassword({ email, password })
    if (sErr || !signIn.session) throw new Error(`login: ${sErr?.message}`)
    ok("1. partner login", true)
    const cookie = sessionCookies(signIn.session)
    const http = (path: string, init?: RequestInit) =>
      fetch(`${BASE}${path}`, { ...init, headers: { Cookie: cookie, ...(init?.headers ?? {}) }, redirect: "manual" })

    const page = await http("/collab", { headers: { "sec-fetch-mode": "navigate", accept: "text/html" } })
    ok("2. /collab page renders", page.status === 200, `status=${page.status}`)

    const list = await http("/api/td-communication/projects")
    const listBody = await list.json().catch(() => ({}))
    ok("3. projects list = ONLY the assigned fixture", list.status === 200 && listBody.projects?.length === 1 && listBody.projects[0].id === enrollmentId, `count=${listBody.projects?.length}`)

    const detail = await http(`/api/td-communication/projects/${enrollmentId}`)
    const detailBody = await detail.json().catch(() => ({}))
    const signedUrl = detailBody.project?.uploads?.[0]?.url as string | undefined
    ok("4. own brief opens + file URL signed", detail.status === 200 && !!signedUrl && signedUrl.includes("token="), `uploads=${detailBody.project?.uploads?.length}`)

    if (foreign?.id) {
      const foreignRes = await http(`/api/td-communication/projects/${foreign.id}`)
      ok("5. FOREIGN brief → 404 (scoping holds)", foreignRes.status === 404, `status=${foreignRes.status}`)
    } else {
      console.log("  ⚠️ no foreign enrollment available to probe (skipped)")
    }

    let downloaded = ""
    if (signedUrl) {
      const dl = await fetch(signedUrl)
      downloaded = await dl.text()
      ok("6. file DOWNLOADED via signed URL, content matches", dl.status === 200 && downloaded === fileContent, `status=${dl.status}`)
    }

    // Chat: the collab page get-or-created the partner's conversation.
    const convs = await http("/api/conversations")
    const convBody = await convs.json().catch(() => ({}))
    const convId = convBody.conversations?.[0]?.id
    ok("7. partner conversation exists", !!convId)
    if (convId) {
      const msgs = await http(`/api/conversations/messages?conversation_id=${convId}`)
      ok("8. chat read", msgs.status === 200)
      const send = await http("/api/conversations/messages", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversation_id: convId, body: "QA E2E ping" }),
      })
      ok("9. chat send", send.status === 201, `status=${send.status}`)
    }

    // ── The audit rows (the deliverable Antonio asked to SEE) ──────
    await new Promise(r => setTimeout(r, 1200)) // fire-and-forget writes settle
    const { data: logRows } = await db.from("partner_access_log")
      .select("created_at, surface, method, path, resource, detail")
      .eq("partner_id", partnerId)
      .order("created_at", { ascending: true })
    console.log(`\n== ACCESS LOG ROWS for the throwaway partner (${logRows?.length ?? 0}) ==`)
    for (const r of logRows ?? []) {
      console.log(`  ${r.created_at.slice(11, 19)}  ${r.surface.padEnd(22)} ${r.resource ?? JSON.stringify(r.detail)}`)
    }
    const surfaces = new Set((logRows ?? []).map((r: { surface: string }) => r.surface))
    ok("10. log covers page + list + brief + FILE + chat", ["collab_page", "projects_list", "project_brief", "file_signed", "chat_read", "chat_send"].every(s => surfaces.has(s)), `got: ${[...surfaces].join(",")}`)
    const fileRows = (logRows ?? []).filter((r: { surface: string }) => r.surface === "file_signed")
    ok("11. the file grant has its own explicit row with the exact path", fileRows.length === 1 && fileRows[0].resource === filePath)
  } finally {
    await cleanup()
    console.log("\n  🧹 all fixtures + shown log rows cleaned up")
  }

  console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==\n`)
  if (fail > 0) process.exit(1)
}

main().catch(err => { console.error("FATAL:", err); process.exit(1) })
