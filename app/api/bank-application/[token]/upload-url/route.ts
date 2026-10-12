/**
 * POST /api/bank-application/[token]/upload-url — signed direct-to-storage upload link for ONE document.
 *
 * Owner-only (the browser that opened the link). Body: { slot, file_name, file_size, mime }.
 * Vercel rejects request bodies over 4.5 MB, so files go browser -> private bucket via the
 * signed link. The path is minted HERE under this link's own token + a known slot — the client
 * never chooses it.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { gateLink } from "@/lib/bofa-intake/access"
import {
  BOFA_BUCKET,
  BOFA_DOC_SLOTS,
  BOFA_MAX_FILE_BYTES,
  buildUploadPath,
  effectiveMime,
  isAllowedMime,
} from "@/lib/bofa-intake/schema"

type Params = { params: Promise<{ token: string }> }

export async function POST(req: NextRequest, { params }: Params) {
  const { token } = await params
  const gate = await gateLink(req, token, false)
  if ("reason" in gate) {
    if (gate.reason === "error") return NextResponse.json({ error: "Something went wrong on our side. Please try again." }, { status: 503 })
    return NextResponse.json({ error: "This link is no longer active." }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const slot = typeof body.slot === "string" ? body.slot : ""
  const fileName = typeof body.file_name === "string" ? body.file_name : ""
  const fileSize = typeof body.file_size === "number" && Number.isFinite(body.file_size) ? body.file_size : 0
  const mime = effectiveMime(fileName, typeof body.mime === "string" ? body.mime : "")

  if (!BOFA_DOC_SLOTS.some((s) => s.key === slot)) return NextResponse.json({ error: "Unknown document box." }, { status: 400 })
  if (!fileName || fileSize <= 0) return NextResponse.json({ error: "The file is empty." }, { status: 400 })
  if (fileSize > BOFA_MAX_FILE_BYTES) {
    const mb = (fileSize / (1024 * 1024)).toFixed(1)
    return NextResponse.json({ error: `That file is ${mb} MB. The limit is 10 MB per document.` }, { status: 400 })
  }
  if (!isAllowedMime(mime)) {
    return NextResponse.json({ error: "Upload a PDF or a photo (JPG, PNG, HEIC or WebP)." }, { status: 400 })
  }

  const path = buildUploadPath(token, slot, randomUUID(), fileName)
  const { data, error } = await supabaseAdmin.storage.from(BOFA_BUCKET).createSignedUploadUrl(path, { upsert: false })
  if (error || !data) {
    console.error("[bank-application] signed-URL error:", error)
    return NextResponse.json({ error: "Could not start the upload. Please try again." }, { status: 500 })
  }
  return NextResponse.json({ signedUrl: data.signedUrl, token: data.token, path })
}
