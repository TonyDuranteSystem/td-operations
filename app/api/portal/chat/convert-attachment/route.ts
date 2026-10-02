/**
 * POST /api/portal/chat/convert-attachment — an iPhone photo (HEIC/HEIF) sent in a chat becomes a JPEG (Antonio 2026-10-02).
 * The browser uploads straight to Storage (signed URL), so the server never sees the bytes at upload time; right after the upload the
 * browser calls this with the stored path. The server downloads the HEIC, saves a JPEG next to it, deletes the HEIC and returns the
 * JPEG's public URL. Any failure leaves the HEIC in place (the caller keeps it; the viewers still convert on the fly).
 * Body: { path, account_id?, contact_id?, name } → { url, name, mime_type, size }
 * Access mirrors /api/portal/chat/upload-url; the path must be a .heic/.heif this thread's uploader made.
 */
export const dynamic = "force-dynamic"
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { getClientContactId } from "@/lib/portal-auth"
import { canAccessAccount } from "@/lib/portal/team/gate"
import { convertibleChatPath, jpegPathBeside } from "@/lib/portal/chat-attachment-path"
import { HEIC_CONVERT_MAX_BYTES } from "@/lib/crm-store/writer"

export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  const path: string = typeof body.path === "string" ? body.path : ""
  const name: string = typeof body.name === "string" && body.name ? body.name : "photo.heic"
  const accountId: string | null = body.account_id || null
  const contactId: string | null = body.contact_id || null
  if (!accountId && !contactId) return NextResponse.json({ error: "account_id or contact_id required" }, { status: 400 })
  if (!convertibleChatPath(path, accountId, contactId)) return NextResponse.json({ error: "This file cannot be converted." }, { status: 400 })

  const isClientUser = (user.app_metadata as Record<string, unknown> | undefined)?.role === "client"
  const authContactId = getClientContactId(user)
  if (accountId) {
    if (!(await canAccessAccount(user, accountId, "chat"))) return NextResponse.json({ error: "Access denied" }, { status: 403 })
  } else if (isClientUser && (!authContactId || (contactId && contactId !== authContactId))) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 })
  }

  try {
    const { data: blob, error: dlErr } = await supabaseAdmin.storage.from("assets").download(path)
    if (dlErr || !blob) return NextResponse.json({ error: "The photo could not be read." }, { status: 404 })
    if (blob.size > HEIC_CONVERT_MAX_BYTES) return NextResponse.json({ error: "This photo is too large to convert." }, { status: 413 })
    const { jpegForSaving, jpegNameFor } = await import("@/lib/image-heic")
    const j = await jpegForSaving({ name, mimeType: blob.type || "image/heic", bytes: Buffer.from(await blob.arrayBuffer()) })
    if (!j.converted) return NextResponse.json({ error: "This photo could not be converted." }, { status: 422 })
    const jpegPath = jpegPathBeside(path)
    const { error: upErr } = await supabaseAdmin.storage.from("assets").upload(jpegPath, j.bytes, { contentType: "image/jpeg", upsert: false })
    if (upErr) return NextResponse.json({ error: "The converted photo could not be saved." }, { status: 500 })
    await supabaseAdmin.storage.from("assets").remove([path]).catch(() => {})     // the HEIC goes only AFTER the JPEG is safely stored
    const { data: urlData } = supabaseAdmin.storage.from("assets").getPublicUrl(jpegPath)
    return NextResponse.json({ url: urlData.publicUrl, name: jpegNameFor(name), mime_type: "image/jpeg", size: j.bytes.length })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The photo could not be converted." }, { status: 500 })
  }
}
