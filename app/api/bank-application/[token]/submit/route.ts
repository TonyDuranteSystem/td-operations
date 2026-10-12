/**
 * POST /api/bank-application/[token]/submit — records the finished application and kills the link.
 *
 * Owner-only. Body: { data, files: [{ key, name, path }] }. Everything is validated server-side
 * with the same schema the page uses; each file must really exist in the bucket under THIS link's
 * own token. The final UPDATE only succeeds while the row is still 'opened', so a double-click or a
 * replay cannot submit twice. v1 only STORES the application and pings staff — nothing is forwarded
 * to any outside party.
 */

export const maxDuration = 120
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { gateLink } from "@/lib/bofa-intake/access"
import { BOFA_BUCKET, validateSubmission } from "@/lib/bofa-intake/schema"
import { CRM_BASE_URL } from "@/lib/config"
import { deliverSubmission } from "@/lib/bofa-intake/deliver"
import { archiveSubmission } from "@/lib/bofa-intake/archive"

type Params = { params: Promise<{ token: string }> }

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- new table not in the generated DB types
const table = () => (supabaseAdmin as any).from("bofa_intake_requests")

async function fileExists(path: string): Promise<boolean> {
  const slash = path.lastIndexOf("/")
  const dir = path.slice(0, slash)
  const name = path.slice(slash + 1)
  const { data, error } = await supabaseAdmin.storage.from(BOFA_BUCKET).list(dir, { search: name, limit: 5 })
  if (error || !data) return false
  return data.some((o) => o.name === name)
}

async function notifyStaff(label: string, companyName: string, id: string): Promise<boolean> {
  try {
    const { gmailPost } = await import("@/lib/gmail")
    const subject = `Bank application submitted: ${label}`
    const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <h2 style="color:#1e3a5f;">Bank application submitted</h2>
      <p>The one-time application link <strong>${escapeHtml(label)}</strong> was submitted (company: <strong>${escapeHtml(companyName)}</strong>).</p>
      <p>Review the answers and documents: <a href="${CRM_BASE_URL}/bofa-intake?open=${id}">${CRM_BASE_URL}/bofa-intake</a></p>
      <p style="color:#666;font-size:12px;">Nothing has been sent to anyone outside Tony Durante LLC.</p></div>`
    const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
    const raw = [
      "From: Tony Durante LLC <support@tonydurante.us>",
      "To: support@tonydurante.us",
      `Subject: ${encodedSubject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(html).toString("base64"),
    ].join("\r\n")
    await gmailPost("/messages/send", { raw: Buffer.from(raw).toString("base64url") })
    return true
  } catch (e) {
    console.error("[bank-application] staff notification failed:", e)
    return false
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string))
}

export async function POST(req: NextRequest, { params }: Params) {
  const { token } = await params
  const gate = await gateLink(req, token, false)
  if ("reason" in gate) {
    if (gate.reason === "error") return NextResponse.json({ error: "Something went wrong on our side. Please try again." }, { status: 503 })
    return NextResponse.json({ error: "This link is no longer active." }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const result = validateSubmission(body.data, body.files, token)
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 400 })

  for (const f of result.files) {
    if (!(await fileExists(f.path))) {
      return NextResponse.json({ error: `The file for "${f.name}" did not finish uploading. Please upload it again.` }, { status: 400 })
    }
  }

  const { data: updated, error } = await table()
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      form_data: result.data,
      files: result.files,
      updated_at: new Date().toISOString(),
    })
    .eq("id", gate.row.id)
    .eq("status", "opened")
    .select("id, label")
    .maybeSingle()
  if (error) return NextResponse.json({ error: "Could not save your application. Please try again." }, { status: 500 })
  if (!updated) {
    const { data: now } = await table().select("status").eq("id", gate.row.id).maybeSingle()
    const message = now?.status === "revoked"
      ? "This link was cancelled. Ask Tony Durante LLC for a new one."
      : "This application was already submitted."
    return NextResponse.json({ error: message }, { status: 409 })
  }

  const sent = await notifyStaff(updated.label, result.data.company_name, updated.id)
  if (sent) await table().update({ notified_at: new Date().toISOString() }).eq("id", updated.id)

  // The application is safely stored. First file it in CRM Storage (Business › BofA), then email it to the
  // addresses staff chose for this link (if any). A failure in either never fails the client's submission —
  // it is recorded on the row and staff can press "Save to Storage" / "Resend email".
  try {
    await archiveSubmission(updated.id)
  } catch (e) {
    console.error("[bank-application] archive crashed:", e)
  }
  try {
    await deliverSubmission(updated.id)
  } catch (e) {
    console.error("[bank-application] delivery crashed:", e)
  }

  const res = NextResponse.json({ ok: true })
  res.headers.set("Cache-Control", "no-store")
  return res
}
