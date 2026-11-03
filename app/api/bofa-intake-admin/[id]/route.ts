/**
 * Staff-only (admins + the logins named in lib/auth/forms-access.ts) detail + actions for one Bank of America intake link.
 *   GET   /api/bofa-intake-admin/[id]                  — the answers + a 1-hour download link per document
 *   PATCH /api/bofa-intake-admin/[id] { action: "review" }     — mark a submitted application Reviewed (enables Submit)
 *                                      { action: "submit", confirm_to: [...] } — email the reviewed application to the
 *                                        saved bank-contact address(es); confirm_to must be what the confirm box showed
 *                                      { action: "send_back", note, email? } — write a note, make a NEW one-time link, email the client
 *                                        (email:false = "Create link only": no email, the link is returned to share by hand)
 *                                      { action: "revoke" }     — kill a link that has not been submitted
 *                                      { action: "archive" }      — (re)save a submitted application in CRM Storage
 *                                      { action: "reset_lock" } — hand an opened-but-unsubmitted link back
 *                                        to "not opened" (the client switched browser / cleared cookies)
 * There is deliberately NO "resend" action: it used to be the way around the review. A failed Submit is retried by Submit.
 */

// Submit runs the whole send here (reading up to ~18 MB of documents, then Gmail), so it gets the same room the old submit route had.
export const maxDuration = 120
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { canUseForms } from "@/lib/auth"
import { BOFA_BUCKET, BOFA_DOC_SLOTS } from "@/lib/bofa-intake/schema"
import { deliverSubmission } from "@/lib/bofa-intake/deliver"
import { archiveSubmission } from "@/lib/bofa-intake/archive"
import { markReviewed } from "@/lib/bofa-intake/review"
import { sendBackToClient } from "@/lib/bofa-intake/send-back"
import { DETAIL_COLUMNS, readWithReviewColumns } from "@/lib/bofa-intake/columns"
import { describeSubmissionFile, signedUrlForSubmissionFile, type SubmissionFile } from "@/lib/bofa-intake/files"

type Params = { params: Promise<{ id: string }> }

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- new table not in the generated DB types
const table = () => (supabaseAdmin as any).from("bofa_intake_requests")

// Administrators plus the staff logins named in lib/auth/forms-access.ts (the same rule as the Forms menu item and page guard).
async function adminUser() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user && canUseForms(user) ? user : null
}

/** Delete everything uploaded under a link that never produced a submission (passports must not linger). */
async function removeUploads(token: string): Promise<void> {
  try {
    const paths: string[] = []
    for (const slot of BOFA_DOC_SLOTS) {
      const { data } = await supabaseAdmin.storage.from(BOFA_BUCKET).list(`${token}/${slot.key}`, { limit: 100 })
      for (const o of data ?? []) paths.push(`${token}/${slot.key}/${o.name}`)
    }
    if (paths.length) await supabaseAdmin.storage.from(BOFA_BUCKET).remove(paths)
  } catch (e) {
    console.error("[bofa-intake-admin] cleanup failed:", e)
  }
}

export async function GET(_req: NextRequest, { params }: Params) {
  if (!(await adminUser())) return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  const { id } = await params
  const { data: row, error, reviewReady } = await readWithReviewColumns<Record<string, unknown>>(DETAIL_COLUMNS, (columns) =>
    table().select(columns).eq("id", id).maybeSingle(),
  )
  if (error || !row) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const files = Array.isArray(row.files) ? (row.files as SubmissionFile[]) : []
  const withUrls = await Promise.all(
    files.map(async (f) => {
      const url = await signedUrlForSubmissionFile(f, 3600)
      const slot = BOFA_DOC_SLOTS.find((s) => s.key === f.key)
      // the name staff see and download matches the bytes in Storage (an iPhone photo is stored as a JPEG)
      const { name } = await describeSubmissionFile(f)
      return { key: f.key, label: slot?.label ?? f.key, name, url }
    }),
  )
  return NextResponse.json({ review_ready: reviewReady, link: { ...row, files: withUrls } })
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await adminUser()
  if (!user) return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  const { id } = await params
  const body = await req.json().catch(() => ({}))

  if (body.action === "archive") {
    const r = await archiveSubmission(id)
    if ("error" in r) return NextResponse.json({ error: r.error }, { status: 409 })
    return NextResponse.json({ ok: true, folder_id: r.folderId, already: r.already })
  }

  if (body.action === "review") {
    const r = await markReviewed(id, user.email ?? "staff")
    if ("error" in r) return NextResponse.json({ error: r.error }, { status: 409 })
    return NextResponse.json({ ok: true })
  }

  if (body.action === "submit") {
    const confirmTo = Array.isArray(body.confirm_to) ? body.confirm_to.filter((x: unknown): x is string => typeof x === "string") : []
    const r = await deliverSubmission(id, { by: user.email ?? "staff", confirmTo })
    if ("error" in r) return NextResponse.json({ error: r.error }, { status: 409 })
    return NextResponse.json({ ok: true, sent_to: r.sentTo })
  }

  if (body.action === "send_back") {
    const r = await sendBackToClient(id, user.email ?? "staff", body.note, { email: body.email !== false })
    if ("error" in r) return NextResponse.json({ error: r.error }, { status: 409 })
    return NextResponse.json({ ok: true, new_id: r.newId, url: r.url, emailed: r.emailed, emailed_to: r.emailedTo, email_error: r.emailError ?? null, link_only: r.linkOnly === true })
  }

  if (body.action === "reset_lock") {
    const { data, error } = await table()
      .update({ status: "pending", opener_hash: null, opened_at: null, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "opened")
      .select("id, token")
      .maybeSingle()
    if (error) return NextResponse.json({ error: "Could not reset the link." }, { status: 500 })
    if (!data) return NextResponse.json({ error: "Only a link that was opened but not submitted can be reset." }, { status: 409 })
    // Whatever the previous opener already uploaded belongs to an application that never happened.
    await removeUploads(data.token)
    return NextResponse.json({ ok: true })
  }

  if (body.action !== "revoke") return NextResponse.json({ error: "Unknown action" }, { status: 400 })
  const { data, error } = await table()
    .update({ status: "revoked", updated_at: new Date().toISOString() })
    .eq("id", id)
    .in("status", ["pending", "opened"])
    .select("id, token")
    .maybeSingle()
  if (error) return NextResponse.json({ error: "Could not revoke the link." }, { status: 500 })
  if (!data) return NextResponse.json({ error: "This link was already submitted or revoked." }, { status: 409 })
  await removeUploads(data.token)
  return NextResponse.json({ ok: true })
}
