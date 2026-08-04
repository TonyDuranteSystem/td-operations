/**
 * GET /api/inbox/worker-chat/prepared-send/<prepared_id>/attachment/<index>
 *
 * Streams one attachment of a frozen draft so the staff member can OPEN the file
 * on the Confirm card before deciding — the card shows what is going out, not
 * just its name.
 *
 * Addressed by POSITION, never by storage path: the card carries an id and an
 * index, and this route resolves the location server-side. That matters most in
 * Team Chat, where the card is a permanent channel message — a signed URL baked
 * into that row would be either dead in hours (a broken tile living forever in
 * the scrollback) or a long-lived bearer link to a client document sitting in
 * chat history. Here, authorisation is re-checked on every single open.
 *
 * Staff-only, like every other /api/inbox route (the middleware session gate
 * covers the prefix; the explicit check below is the one that must hold if that
 * ever changes). Inline, private, never cached by a shared cache.
 */
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isDashboardUser } from "@/lib/auth"
import { WORKER_UPLOAD_BUCKET, isValidWorkerUploadPath } from "@/lib/ai-agent/attachment-reader"

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string; index: string } },
) {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  const index = Number.parseInt(params.index, 10)
  if (!Number.isInteger(index) || index < 0) {
    return NextResponse.json({ error: "Bad attachment index" }, { status: 400 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: row, error } = await (supabaseAdmin as any)
    .from("worker_prepared_sends")
    .select("attachments")
    .eq("id", params.id)
    .maybeSingle()
  if (error || !row) {
    return NextResponse.json({ error: "Draft not found" }, { status: 404 })
  }

  // Deliberately NOT gated on status: a staff member looking at a card that was
  // just sent (or superseded) must still be able to see what left. Reading is
  // not sending, and hiding it after the fact only makes the record harder to
  // check.
  const list = (row.attachments ?? []) as Array<{ path?: string; name?: string; content_type?: string }>
  const att = list[index]
  if (!att?.path) {
    return NextResponse.json({ error: "Attachment not found" }, { status: 404 })
  }
  // Every frozen attachment is materialised into the private bucket at prepare,
  // so this always holds. It is checked anyway: the value is read back out of a
  // jsonb column, and this is the gate that stops an arbitrary path reaching the
  // service-role client (which bypasses RLS).
  if (!isValidWorkerUploadPath(att.path)) {
    return NextResponse.json({ error: "Attachment not readable" }, { status: 404 })
  }

  const { data: file, error: dlErr } = await supabaseAdmin.storage.from(WORKER_UPLOAD_BUCKET).download(att.path)
  if (dlErr || !file) {
    return NextResponse.json({ error: "File no longer available" }, { status: 404 })
  }
  const bytes = Buffer.from(await file.arrayBuffer())

  // The filename can be a client's own naming ("Contratto società.pdf", or a
  // name in Chinese). A raw non-Latin-1 character makes Node reject the header
  // and 500 the click; the MIME encoded-word form used for email is NOT valid
  // here and would show the user the encoding itself. So: an ASCII-safe
  // `filename` plus the RFC 5987 `filename*` that browsers actually read.
  const rawName = String(att.name ?? "file")
    .replace(/[\r\n"\\]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 180)
  const safeName = rawName || "file"
  // eslint-disable-next-line no-control-regex
  const asciiName = /^[\x20-\x7e]*$/.test(safeName) ? safeName : safeName.replace(/[^\x20-\x7e]/g, "_")
  // encodeURIComponent leaves ! ' ( ) * unescaped, and none of those are valid
  // in an RFC 5987 ext-value — an apostrophe is especially bad, since the value
  // is a charset'lang'value triple. Real filenames hit this constantly
  // ("EIN Letter (IRS) - Acme.pdf", "Client's letter.pdf").
  const rfc5987 = encodeURIComponent(safeName).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  const dispositionName = `filename="${asciiName}"; filename*=UTF-8''${rfc5987}`
  const declared = (att.content_type || file.type || "application/octet-stream").toLowerCase()

  // WHAT MAY RENDER IN THE BROWSER, AND WHAT MUST ONLY DOWNLOAD.
  //
  // These bytes can originate with a CLIENT — anything they posted in a portal
  // chat is attachable, and its content type comes off their own upload. Served
  // `inline` from the CRM's own origin, an HTML or SVG file would run script in
  // a staff session, and the file tile makes clicking it the designed action.
  // So: a short allow-list renders, everything else downloads, and `nosniff`
  // stops the browser second-guessing the type we declare.
  const renderable =
    declared.startsWith("image/") && !declared.includes("svg")
      ? declared
      : declared === "application/pdf" || declared.startsWith("text/plain")
        ? declared
        : null
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": renderable ?? "application/octet-stream",
      "Content-Disposition": `${renderable ? "inline" : "attachment"}; ${dispositionName}`,
      "X-Content-Type-Options": "nosniff",
      // NO `sandbox` DIRECTIVE, and no `default-src 'none'` on its own.
      //
      // `sandbox` forces an opaque origin and disables the browser's built-in
      // PDF plugin, and a bare `default-src 'none'` blanks a directly-opened
      // image — between them they would break the exact click this feature is
      // built around, on the two types it renders. VERIFIED: an image opened
      // from a card renders (browser reported it as a 32×32 document). NOT
      // verified: a large PDF in real Chrome — the in-app browser used for QA
      // intercepts big file responses as downloads, so the render could not be
      // exercised there. The headers are correct (`application/pdf`, `inline`),
      // and this is worth one look on a real machine.
      //
      // What remains is still strict: a document served from here may load
      // itself and nothing else — no scripts, no frames, no fetches — and it
      // only ever applies to the three types allowed inline above. Anything
      // else (HTML, SVG) is forced to download before the CSP is even the
      // question, and `nosniff` stops the browser reinterpreting the type.
      "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; object-src 'self'",
      "Cache-Control": "private, no-store",
    },
  })
}
