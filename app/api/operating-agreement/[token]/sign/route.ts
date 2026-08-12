/**
 * POST /api/operating-agreement/[token]/sign
 *
 * The client executes their Operating Agreement — SERVER-SIDE.
 *
 * ⛔ WHY THIS EXISTS / WHAT IT REPLACES.
 *
 * Until now signing happened in the browser: it screenshotted the page with
 * html2pdf and wrote the signature, the status and the PDF path straight into the
 * database with the ANON key (a real security hole — a token-guesser could repoint
 * an agreement at their own PDF and mark it signed). The signed copy was a picture
 * of the screen — not real text, and it carried whatever was on screen.
 *
 * This route moves all of that onto the server:
 *   - the access code is verified server-side (shared guard);
 *   - WHICH member is signing is resolved from their per-member access code, never
 *     from a client-supplied index — so one member cannot sign as another;
 *   - the signer's IP + user-agent + consent are captured HERE, from the request,
 *     for the Certificate of Completion;
 *   - the signature row is written with the SERVICE key (the anon writes are gone);
 *   - "who is the last signer" is decided by an ATOMIC counter, so two members
 *     signing at the same instant cannot both think they are last (or neither);
 *   - on the last signature the server RENDERS the executed agreement as real text,
 *     appends the same legal Certificate of Completion the e-sign engine uses
 *     (who / when / device / IP / consent + a document fingerprint), and files it.
 *
 * The signature image itself is produced by the client (draw / type / upload) and
 * arrives as a PNG data URL — this route does not care which of the three it was,
 * only that it is a PNG. It is the client's own signature on the client's own
 * document; we record how it was made and move on, exactly as a DocuSign-class tool
 * does.
 *
 * Filing to Drive + the formation-flow side-effects stay owned by /api/oa-signed,
 * called from the shared finalizer once the executed PDF is stored.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { createHash } from "crypto"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"
import { accessCodeError } from "@/lib/esign/access-guard"
import { checkRateLimit, getRateLimitKey } from "@/lib/portal/rate-limit"
import { isStaffPreview } from "@/lib/auth/staff-preview"
import { normalizeEntityType } from "@/lib/portal/entity-type"
import { OA_AGREEMENT_SELECT, OA_SIGNATURE_SELECT, resolveSignerIndex, signerLinkState } from "@/lib/oa/public-view"
import { finalizeOaAgreement } from "@/lib/oa/finalize-signing"
import { reportSystemError } from "@/lib/system-errors"
import { internalWebhookServerHeaders } from "@/lib/webhook-internal-auth"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

const SIGNATURE_BUCKET = "signed-oa"
const MAX_SIGNATURE_BYTES = 3 * 1024 * 1024 // a signature PNG; not an archive

// Server-only select — adds account_id/contact_id the public whitelist withholds.
const OA_SIGN_SELECT = `${OA_AGREEMENT_SELECT}, account_id, contact_id`

/** Decode a `data:image/png;base64,...` URL to raw bytes, or null if it is not one. */
function pngFromDataUrl(dataUrl: unknown): Uint8Array | null {
  if (typeof dataUrl !== "string") return null
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim())
  if (!m) return null
  try {
    const buf = Buffer.from(m[1], "base64")
    if (buf.length === 0 || buf.length > MAX_SIGNATURE_BYTES) return null
    // PNG magic number — reject anything mislabelled.
    if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null
    return new Uint8Array(buf)
  } catch {
    return null
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  const rl = checkRateLimit(`${getRateLimitKey(req)}:oa-sign`, 8, 60_000)
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many attempts. Please wait a moment and try again." }, { status: 429 })
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Could not read the submission. Please try again." }, { status: 400 })
  }

  const code = String(body.code || "")
  const signerCode = body.signer ? String(body.signer) : null
  const previewFlag = String(body.preview || "") === "td"
  const isPreview = await isStaffPreview(previewFlag)
  const consent = body.consent === true
  const method = body.signature_method === "typed" || body.signature_method === "uploaded" ? body.signature_method : "drawn"
  const typedName = typeof body.signed_by_name === "string" ? body.signed_by_name.trim().slice(0, 120) : null

  const signaturePng = pngFromDataUrl(body.signature_png)
  if (!signaturePng) {
    return NextResponse.json(
      { error: "Your signature could not be read. Please sign again." },
      { status: 400 },
    )
  }
  if (!consent) {
    return NextResponse.json(
      { error: "Please confirm you agree to sign electronically before signing." },
      { status: 400 },
    )
  }

  const { data: agreement, error: agreementErr } = await db
    .from("oa_agreements")
    .select(OA_SIGN_SELECT)
    .eq("token", token)
    .maybeSingle()

  if (agreementErr) {
    console.error("[oa/sign] agreement lookup failed:", agreementErr)
    return NextResponse.json(
      { error: "Could not load the Operating Agreement. Please try again, or contact support@tonydurante.us." },
      { status: 503 },
    )
  }
  if (!agreement) {
    return NextResponse.json({ error: "Operating Agreement not found." }, { status: 404 })
  }

  const codeErr = accessCodeError(req, { token, expected: agreement.access_code, provided: code, isPreview })
  if (codeErr) return NextResponse.json({ error: codeErr.error }, { status: codeErr.status })

  // Staff preview may READ but must NEVER affix a real signature — the same rule
  // the Sign button follows. A preview link executing a client's legal document,
  // attributed to that client, is indistinguishable in the record from the client.
  if (isPreview || previewFlag) {
    return NextResponse.json(
      { error: "Admin preview cannot sign an agreement. Open it as the client to do that." },
      { status: 403 },
    )
  }

  if (agreement.status === "voided") {
    return NextResponse.json(
      { error: "This Operating Agreement has been voided and is no longer valid. Please generate a new one from your portal, or contact support@tonydurante.us." },
      { status: 410 },
    )
  }
  if (agreement.status === "signed") {
    return NextResponse.json({ error: "This Operating Agreement is already complete." }, { status: 409 })
  }

  const totalSigners = agreement.total_signers || 1

  // Load the signature rows (MMLLC has one per member; SMLLC has none yet).
  const { data: sigRows } = await db
    .from("oa_signatures")
    .select(OA_SIGNATURE_SELECT)
    .eq("oa_id", agreement.id)
    .order("member_index")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const signatures: any[] = sigRows ?? []

  // Per-member signing is decided by whether per-member signature RECORDS
  // exist, never by counting expected signatures.
  //
  // It used to read `total_signers > 1`, which silently collapsed a multi-member
  // agreement that had only one expected signature into single-signer mode: the
  // submitted signer code was ignored, anyone holding the shared access code
  // could sign, and the signature was recorded under the agreement's own
  // member_name — the FIRST row of the roster — rather than under whoever
  // actually signed. The issuing rule now prevents that state from being
  // created (lib/members/signing-set.ts), but agreements created before it, or
  // by any other path, must still be handled correctly here.
  //
  // Safe against existing data: an SMLLC has no signature rows, so it stays
  // single-signer. Checked on production 2026-08-09 — the only agreements with
  // one expected signature that carry a signature row are single-member and
  // already fully signed, so none of them changes behaviour.
  const isMultiSigner =
    normalizeEntityType(agreement.entity_type) === "MMLLC" && signatures.length > 0

  // Resolve WHICH member is signing — from the per-member access code, never a
  // client-supplied index. SMLLC has a single implicit signer (index 0).
  let memberIndex: number
  let memberName: string
  let memberEmail: string | null
  if (isMultiSigner) {
    const idx = resolveSignerIndex(signatures, signerCode)
    if (idx === null) {
      return NextResponse.json({ error: "Invalid signing link." }, { status: 403 })
    }
    memberIndex = idx
    const row = signatures.find(s => s.member_index === idx)
    // Die-on-change + expiry: this member's link may be dead even though the
    // shared code is right. A signature already recorded is never blocked (the
    // guard below excludes signed rows anyway); an unsigned one that was revoked
    // (membership changed) or has expired must not sign — with the signature
    // possibly already drawn on screen, the message says to request a fresh link,
    // never "invalid link".
    const state = row ? signerLinkState(row) : "ok"
    if (state === "revoked") {
      return NextResponse.json(
        { error: "This signing link is no longer valid because the company's members changed. Please ask the company owner to re-issue it from the portal." },
        { status: 403 },
      )
    }
    if (state === "expired") {
      return NextResponse.json(
        { error: "This signing link has expired. Please ask the company owner to re-send it from the portal, then sign from the fresh link." },
        { status: 403 },
      )
    }
    memberName = row?.member_name || agreement.member_name || "Member"
    memberEmail = row?.member_email ?? null
  } else {
    memberIndex = 0
    // Prefer the signature record's own name over the agreement header. For a
    // single-member company the two agree; where they ever disagree the record
    // is the one that describes who is actually signing THIS row, and the
    // header is a summary written at creation time. The executed document and
    // the Certificate of Completion are built from this value, so a wrong name
    // here is a wrong name on a legal instrument.
    const row = signatures.find(s => s.member_index === 0)
    memberName = row?.member_name || agreement.member_name || "Member"
    memberEmail = row?.member_email ?? agreement.member_email ?? null
  }

  const now = new Date().toISOString()
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || req.headers.get("x-real-ip") || null
  const userAgent = req.headers.get("user-agent")?.slice(0, 400) || null
  const signatureHash = createHash("sha256").update(Buffer.from(signaturePng)).digest("hex")

  // Store the signature image (service key).
  const sigPath = `${token}/sig-${memberIndex}.png`
  const { error: sigUpErr } = await supabaseAdmin.storage
    .from(SIGNATURE_BUCKET)
    .upload(sigPath, Buffer.from(signaturePng), { contentType: "image/png", upsert: true })
  if (sigUpErr) {
    console.error("[oa/sign] signature upload failed:", sigUpErr)
    return NextResponse.json(
      { error: "Could not save your signature. Please try again." },
      { status: 503 },
    )
  }

  const sigFields = {
    status: "signed",
    signed_at: now,
    signature_image_path: sigPath,
    signed_by_name: typedName || memberName,
    last_ip: ip,
    last_user_agent: userAgent,
    consent,
    signature_method: method,
    signature_hash: signatureHash,
    updated_at: now,
  }

  // Write the signer's row — GUARDED so a double-submit cannot re-sign / re-count.
  const existingRow = signatures.find(s => s.member_index === memberIndex)
  if (existingRow) {
    const { data: updated, error: updErr } = await db
      .from("oa_signatures")
      .update(sigFields)
      .eq("id", existingRow.id)
      .neq("status", "signed")
      .select("id")
    if (updErr) {
      console.error("[oa/sign] signature row update failed:", updErr)
      return NextResponse.json({ error: "Could not record your signature. Please try again." }, { status: 503 })
    }
    if (!updated || updated.length === 0) {
      // Already signed (double submit / retry) — not an error; nothing to count again.
      return NextResponse.json({ ok: true, alreadySigned: true })
    }
  } else {
    // SMLLC (or any agreement with no pre-seeded row): create the signature record.
    // This also fixes the long-standing gap where signed single-member agreements
    // carried no signature record at all. The unique (oa_id, member_index) guards
    // a double-insert race — the second loses and is treated as already-signed.
    const { error: insErr } = await db.from("oa_signatures").insert({
      oa_id: agreement.id,
      member_index: memberIndex,
      member_name: memberName,
      member_email: memberEmail,
      contact_id: agreement.contact_id ?? null,
      access_code: agreement.access_code,
      ...sigFields,
    })
    if (insErr) {
      // ONLY a unique-violation means "someone else already inserted this
      // signer's row" (a concurrent double-submit) — that is genuinely done.
      // Any OTHER error is a real failure, and reporting it as success is the
      // exact silent-write failure this whole path exists to eliminate: the
      // client sees "Signed", nothing is stored, the counter never moves, and
      // the reconciliation sweep cannot see it either (it looks for a count of
      // at least one). Surface it so they retry.
      const isDuplicate = insErr.code === "23505"
      if (!isDuplicate) {
        console.error("[oa/sign] signature insert failed:", insErr)
        return NextResponse.json(
          { error: "Could not record your signature. Please try again, or contact support@tonydurante.us." },
          { status: 503 },
        )
      }
      console.warn("[oa/sign] duplicate signature insert (concurrent submit) — treating as already signed")
      return NextResponse.json({ ok: true, alreadySigned: true })
    }
  }

  // Atomic last-signer gate. Exactly one concurrent signer sees >= total.
  const { data: newCount } = await db.rpc("increment_oa_signed_count", { oa_uuid: agreement.id })
  const signedCount: number = typeof newCount === "number" ? newCount : signatures.filter(s => s.status === "signed").length + 1
  const isLast = signedCount >= totalSigners

  if (!isLast) {
    // Not the last signer — mark partially_signed, but only from a pre-terminal
    // state so a slow write cannot clobber a 'signed' another signer just set.
    try {
      await db
        .from("oa_agreements")
        .update({ status: "partially_signed", updated_at: now })
        .eq("id", agreement.id)
        .in("status", ["sent", "viewed", "draft", "partially_signed"])
    } catch {
      /* cosmetic — the counter is the source of truth for progress */
    }
    // Fire the partial-sign notification (support email) via the existing route.
    void notifyOaSigned(agreement.id, token, memberIndex)
    return NextResponse.json({ ok: true, allSigned: false, signedCount, totalSigners })
  }

  // ── LAST SIGNER: render the executed agreement + certificate, store it, THEN
  //    flip to signed — all inside the shared finalizer (also used by the sweep
  //    cron). Order matters: on failure the agreement stays partially_signed and is
  //    retried, never "signed with nothing filed."
  const result = await finalizeOaAgreement(agreement.id)
  if (!result.ok) {
    console.error("[oa/sign] finalization failed:", result.error)
    await reportSystemError({
      source: "server",
      route: "/api/operating-agreement/[token]/sign",
      method: "POST",
      message: `Operating Agreement collected its last signature but could not be finalized — ${result.error}`,
      context: { token, oa_id: agreement.id, company: agreement.company_name },
    }).catch(() => {})
    // The signature IS recorded and the counter incremented; the agreement stays
    // partially_signed for the reconciliation cron to finish.
    return NextResponse.json(
      { ok: true, allSigned: false, finalizing: true, signedCount, totalSigners },
      { status: 202 },
    )
  }

  return NextResponse.json({ ok: true, allSigned: true, signedCount, totalSigners })
}

/** Fire the existing filing/notification route server-to-server. Best-effort. */
async function notifyOaSigned(oaId: string, token: string, memberIndex?: number): Promise<void> {
  try {
    await fetch(`${APP_BASE_URL}/api/oa-signed`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...internalWebhookServerHeaders() },
      body: JSON.stringify({ oa_id: oaId, token, member_index: memberIndex }),
    })
  } catch {
    /* reconciliation cron is the safety net */
  }
}
