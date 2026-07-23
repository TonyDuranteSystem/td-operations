/**
 * POST /api/operating-agreement/[token]/hand-signed
 *
 * The client printed the draft, signed it on paper, and is telling us so.
 *
 * ⛔ WHY THIS EXISTS.
 *
 * Signing on screen is not always possible or acceptable — a bank wants wet ink,
 * a member has no portal login, an accountant wants to countersign the paper.
 * Before this, that client had no way to finish: the agreement sat unsigned
 * forever, the portal kept nagging them to sign it, and the formation flow stayed
 * open. Four clients were stuck in exactly that state.
 *
 * ⛔ WHAT THIS IS NOT: A SIGNATURE.
 *
 * Clicking this is the client's WORD that they signed on paper. It is not proof
 * and must never be recorded as though it were:
 *
 *   - `signature_method` is set to 'by_hand', permanently distinguishing this
 *     from an agreement TD actually holds a signature for. Staff can answer
 *     "which agreements do we have a signature on file for?" without opening a
 *     single file.
 *   - The document filed for a declaration WITHOUT an upload is named
 *     "(Unsigned Copy — client signed by hand)". It is the blank draft, and the
 *     filename says so. Filing a blank document under a name implying execution
 *     would be worse than filing nothing.
 *   - `pdf_storage_path` is left ALONE. That column points at the executed
 *     instrument, and for a hand-signed agreement TD does not have one unless the
 *     client uploads a scan.
 *
 * The upload is offered at the moment of declaring, because that is the one
 * moment the client has the signed paper in their hands. It is optional — making
 * it mandatory would just push them back into being stuck, which is the problem
 * this solves. When they do upload, THAT file is the executed agreement and is
 * filed and recorded as such.
 *
 * ACCESS: token plus access code, the same gate as the signing page — this is a
 * public route reached from a client-facing domain, where no portal session
 * exists. An MMLLC co-signer's per-member link works too.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { accessCodeError } from "@/lib/esign/access-guard"
import { checkRateLimit, getRateLimitKey } from "@/lib/portal/rate-limit"
import { isStaffPreview } from "@/lib/auth/staff-preview"
import { normalizeEntityType } from "@/lib/portal/entity-type"
import { generateOperatingAgreementPDF } from "@/lib/pdf/operating-agreement-pdf"
import { OA_AGREEMENT_SELECT, OA_SIGNATURE_SELECT, resolveSignerIndex, toPublicMembers } from "@/lib/oa/public-view"

// The public whitelist withholds account_id / contact_id because the client-facing
// PAGES never render them. This is a server-only route that must FILE to the
// account's Drive folder and log against the contact, so it needs them — added
// here, never sent to a browser.
const OA_HAND_SIGNED_SELECT = `${OA_AGREEMENT_SELECT}, account_id, contact_id`
import { autoSaveDocument } from "@/lib/portal/auto-save-document"
import { reportSystemError } from "@/lib/system-errors"
import type { OAData, OAMember } from "@/lib/types/oa-templates"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

/** Scans are photos or PDFs. Kept small because this is a signature page, not an archive. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
const ALLOWED_UPLOAD_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/heic", "image/heif"]

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  const rl = checkRateLimit(`${getRateLimitKey(req)}:oa-hand-signed`, 5, 60_000)
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many attempts. Please wait a moment and try again." }, { status: 429 })
  }

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ error: "Could not read the submission. Please try again." }, { status: 400 })
  }

  const code = String(form.get("code") || "")
  const signerCode = form.get("signer") ? String(form.get("signer")) : null
  const previewFlag = String(form.get("preview") || "") === "td"
  const isPreview = await isStaffPreview(previewFlag)
  const upload = form.get("file")
  const file = upload instanceof File && upload.size > 0 ? upload : null

  const { data: agreement, error: agreementErr } = await db
    .from("oa_agreements")
    .select(OA_HAND_SIGNED_SELECT)
    .eq("token", token)
    .maybeSingle()

  if (agreementErr) {
    console.error("[oa/hand-signed] agreement lookup failed:", agreementErr)
    return NextResponse.json(
      { error: "Could not load the Operating Agreement. Please try again, or contact support@tonydurante.us." },
      { status: 503 },
    )
  }
  if (!agreement) {
    return NextResponse.json({ error: "Operating Agreement not found." }, { status: 404 })
  }

  const codeErr = accessCodeError(req, {
    token,
    expected: agreement.access_code,
    provided: code,
    isPreview,
  })
  if (codeErr) return NextResponse.json({ error: codeErr.error }, { status: codeErr.status })

  // Staff preview may READ the agreement and must never EXECUTE it — the same
  // rule the Sign button follows. A preview link closing out a real client's
  // legal document, attributed to that client, is indistinguishable in the record
  // from the client doing it themselves.
  if (isPreview || previewFlag) {
    return NextResponse.json(
      { error: "Admin preview cannot complete an agreement. Open it as the client to do that." },
      { status: 403 },
    )
  }

  if (agreement.status === "voided") {
    return NextResponse.json(
      {
        error:
          "This Operating Agreement has been voided and is no longer valid. Please generate a new one from your portal, or contact support@tonydurante.us.",
      },
      { status: 410 },
    )
  }
  if (agreement.status === "signed") {
    return NextResponse.json(
      { error: "This Operating Agreement is already complete." },
      { status: 409 },
    )
  }

  // Validate the upload BEFORE writing anything. A client who picked the wrong
  // file should get a real reason and a second try, not a completed agreement
  // with their scan silently dropped.
  if (file) {
    if (file.size > MAX_UPLOAD_BYTES) {
      const mb = (file.size / (1024 * 1024)).toFixed(1)
      return NextResponse.json(
        { error: `That file is ${mb} MB. Please upload a scan or photo under 10 MB.` },
        { status: 400 },
      )
    }
    if (!ALLOWED_UPLOAD_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: `That file type (${file.type || "unknown"}) is not accepted. Please upload a PDF or a photo.` },
        { status: 400 },
      )
    }
  }

  // Who is declaring? For a multi-signer agreement, resolve them from their
  // personal link so the record names a person rather than "someone".
  const isMultiSigner =
    normalizeEntityType(agreement.entity_type) === "MMLLC" && (agreement.total_signers || 1) > 1

  let declaredBy: string = agreement.member_name || "the client"
  if (isMultiSigner) {
    const { data: sigRows } = await db
      .from("oa_signatures")
      .select(OA_SIGNATURE_SELECT)
      .eq("oa_id", agreement.id)
      .order("member_index")
    const signatures = sigRows ?? []
    const idx = resolveSignerIndex(signatures, signerCode)
    if (signerCode && idx === null) {
      return NextResponse.json({ error: "Invalid signing link." }, { status: 403 })
    }
    const who = signatures.find((s: { member_index: number }) => s.member_index === idx)
    if (who?.member_name) declaredBy = who.member_name
  }

  const now = new Date().toISOString()

  // ── Mark it done ──────────────────────────────────────────────────────────
  // Guarded on the status we read, so two people clicking at once cannot both
  // close it. `pdf_storage_path` is deliberately untouched — see the header.
  const { data: updated, error: updateErr } = await db
    .from("oa_agreements")
    .update({
      status: "signed",
      signed_at: now,
      signature_method: "by_hand",
      signed_count: agreement.total_signers || 1,
      updated_at: now,
    })
    .eq("id", agreement.id)
    .not("status", "in", '("signed","voided")')
    .select("id")

  if (updateErr) {
    console.error("[oa/hand-signed] status update failed:", updateErr)
    return NextResponse.json(
      { error: "Could not record your confirmation. Please try again, or contact support@tonydurante.us." },
      { status: 503 },
    )
  }
  if (!updated || updated.length === 0) {
    // Zero rows means someone else closed it in the gap. Not an error worth
    // alarming them about — it is done either way.
    return NextResponse.json({ ok: true, alreadyComplete: true })
  }

  // Mark every signature row too, so the portal's per-member views agree with the
  // agreement. Non-fatal: the agreement is already the source of truth.
  if (isMultiSigner) {
    try {
      await db
        .from("oa_signatures")
        .update({ status: "signed", signed_at: now, updated_at: now })
        .eq("oa_id", agreement.id)
        .neq("status", "signed")
    } catch {
      /* the agreement's own status governs; a stale row is cosmetic */
    }
  }

  // ── File the documents ────────────────────────────────────────────────────
  // Everything below is best-effort: the client's confirmation is already
  // recorded and must not be undone by a Drive hiccup. Failures escalate to the
  // error audit instead of surfacing as a scary message on a completed action.
  const filed: string[] = []
  try {
    const { data: acct } = await supabaseAdmin
      .from("accounts")
      .select("drive_folder_id")
      .eq("id", agreement.account_id)
      .maybeSingle()

    if (agreement.account_id && acct?.drive_folder_id) {
      const { listFolder, uploadBinaryToDriveUpsert } = await import("@/lib/google-drive")
      const folderResult = (await listFolder(acct.drive_folder_id)) as {
        files?: { id: string; name: string; mimeType: string }[]
      }
      const companyFolder = folderResult.files?.find(
        f => f.name.includes("Company") && f.mimeType === "application/vnd.google-apps.folder",
      )
      const targetFolderId = companyFolder?.id || acct.drive_folder_id

      // 1. The draft the client printed. Named so nobody mistakes it for an
      //    executed agreement when they find it in six months.
      const isMMLLC = isMultiSigner
      const members: OAMember[] = isMMLLC ? (toPublicMembers(agreement.members) ?? []) : []
      const data: OAData = {
        company_name: agreement.company_name,
        state_of_formation: agreement.state_of_formation,
        formation_date: agreement.formation_date,
        ein_number: agreement.ein_number ?? undefined,
        entity_type: isMMLLC ? "MMLLC" : "SMLLC",
        member_name: agreement.member_name,
        member_address: agreement.member_address ?? undefined,
        members: isMMLLC ? members : undefined,
        manager_name: agreement.manager_name || agreement.member_name,
        effective_date: agreement.effective_date,
        business_purpose: agreement.business_purpose,
        initial_contribution: agreement.initial_contribution,
        fiscal_year_end: agreement.fiscal_year_end,
        accounting_method: agreement.accounting_method,
        duration: agreement.duration,
        registered_agent_name: agreement.registered_agent_name ?? undefined,
        registered_agent_address: agreement.registered_agent_address ?? undefined,
        principal_address: agreement.principal_address,
      }
      const draftPdf = await generateOperatingAgreementPDF({ data, draft: true })
      const draftName = `Operating Agreement - ${agreement.company_name} (Unsigned Copy - client signed by hand).pdf`
      const draftFile = (await uploadBinaryToDriveUpsert(
        draftName,
        Buffer.from(draftPdf),
        "application/pdf",
        targetFolderId,
      )) as { id: string }
      await autoSaveDocument({
        accountId: agreement.account_id,
        fileName: draftName,
        documentType: "Operating Agreement",
        category: 1,
        driveFileId: draftFile.id,
        portalVisible: true,
      })
      filed.push("draft")

      // 2. The client's scan, when they gave us one. THIS is the executed
      //    agreement — it is the only artefact in this flow that carries a
      //    signature.
      if (file) {
        const ext = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")) : ".pdf"
        const scanName = `Operating Agreement - ${agreement.company_name} (Signed - hand-signed scan)${ext}`
        const scanFile = (await uploadBinaryToDriveUpsert(
          scanName,
          Buffer.from(await file.arrayBuffer()),
          file.type || "application/pdf",
          targetFolderId,
        )) as { id: string }
        await autoSaveDocument({
          accountId: agreement.account_id,
          fileName: scanName,
          documentType: "Operating Agreement",
          category: 1,
          driveFileId: scanFile.id,
          portalVisible: true,
        })
        filed.push("scan")
      }
    }
  } catch (err) {
    console.error("[oa/hand-signed] filing failed:", err)
    await reportSystemError({
      source: "server",
      route: "/api/operating-agreement/[token]/hand-signed",
      method: "POST",
      message: `Operating Agreement marked hand-signed but its documents could not be filed${
        file ? " — INCLUDING THE CLIENT'S UPLOADED SCAN" : ""
      }`,
      context: { token, company: agreement.company_name, had_upload: !!file, filed },
    }).catch(() => {})
  }

  // ── Tell staff ────────────────────────────────────────────────────────────
  // A hand-signed agreement needs a human to look at it — either to chase the
  // scan, or to check the one that arrived. Silence here would mean nobody ever
  // notices TD is holding a blank document.
  try {
    const { gmailPost } = await import("@/lib/gmail")
    const subject = file
      ? `OA Signed by hand (scan received): ${agreement.company_name}`
      : `OA Signed by hand — NO SIGNED COPY ON FILE: ${agreement.company_name}`
    const bodyLines = [
      `${declaredBy} confirmed they signed the Operating Agreement for ${agreement.company_name} on paper.`,
      ``,
      file
        ? `They uploaded a scan. It is filed to Drive and visible in their portal.`
        : `They did NOT upload a scan. TD holds only the unsigned draft — chase the signed copy.`,
      ``,
      `Entity: ${agreement.entity_type || "SMLLC"}`,
      `Token: ${agreement.token}`,
    ]
    const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
    const raw = [
      `From: Tony Durante LLC <support@tonydurante.us>`,
      `To: support@tonydurante.us`,
      `Subject: ${encodedSubject}`,
      "MIME-Version: 1.0",
      `Content-Type: text/plain; charset=utf-8`,
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(bodyLines.join("\n")).toString("base64"),
    ].join("\r\n")
    await gmailPost("/messages/send", { raw: Buffer.from(raw).toString("base64url") })
  } catch (e) {
    console.warn("[oa/hand-signed] staff notification failed:", e instanceof Error ? e.message : String(e))
  }

  try {
    await supabaseAdmin.from("action_log").insert({
      actor: "client",
      action_type: "oa_hand_signed",
      table_name: "oa_agreements",
      record_id: agreement.id,
      account_id: agreement.account_id || null,
      contact_id: agreement.contact_id || null,
      summary: `Operating Agreement confirmed signed by hand: ${agreement.company_name}${
        file ? " (scan uploaded)" : " (no signed copy on file)"
      }`,
      details: { token, declared_by: declaredBy, had_upload: !!file, filed },
    })
  } catch {
    /* non-blocking */
  }

  return NextResponse.json({ ok: true, uploaded: !!file })
}
