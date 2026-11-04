/**
 * GET /api/crm-store/browse/file/<id>/view — a "simplified view" of the file's current version (or, with ?version=<id>, one OLDER saved copy of it) for the storage screen (2026-10-02):
 * Word → readable page, Excel → tables, Markdown / CSV / JSON … → text. One self-contained HTML page, served with a CSP that forbids
 * every script and a sandbox, so a hostile document cannot run anything. A .zip shows what is inside (names and sizes only); a file whose
 * content reads as plain text is shown as text even when its name says nothing. Same staff + storage-access checks as the plain file route;
 * nothing is written anywhere. EVERY other file also gets a page (Antonio 2026-11-04: all types): PowerPoint / OpenOffice / Apple files / RTF / SVG,
 * TIFF … are converted, anything else (old .doc / .xls, binaries, files too big to read here) gets the details page. ?mode=html shows an HTML file
 * (a saved mockup) as the real page for the screen's locked box. PDF, pictures and video / audio have their own viewers.
 */
export const dynamic = "force-dynamic"
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { denyUnlessStoreStaff, denyUnlessAreaAccess } from "../../../_auth"

const HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "private, no-store",
}

const HTML_PAGE_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-modals",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "private, no-store",
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  // a shared-with-staff tick opens the file's CURRENT copy only — older saved copies need real access to the area
  const versionId = req.nextUrl.searchParams.get("version")
  const noAccess = await denyUnlessAreaAccess({ fileId: params.id }, { allowSharedRead: versionId === null })
  if (noAccess) return noAccess
  try {
    const { readFileForStaff, readVersionForStaff, readHeadForStaff } = await import("@/lib/crm-store/browse")
    const v = await import("@/lib/crm-store/view-html")
    const { viewPageFor, VIEW_HEAD_BYTES } = await import("@/lib/crm-store/view-any")
    // an older saved copy: the same checks as the file itself (area access above), and the version must belong to THIS file
    if (versionId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(versionId)) return NextResponse.json({ error: "Bad version." }, { status: 400 })
    // ?mode=html — an HTML file (a saved mockup) as the REAL page, for the screen's locked box (the iframe has sandbox="allow-scripts …" and NO
    // allow-same-origin, and this CSP sandbox makes the page its own empty origin even if opened directly: it cannot reach the CRM or a login).
    if (req.nextUrl.searchParams.get("mode") === "html") {
      if (versionId !== null) return NextResponse.json({ error: "Only the current copy can be shown as a page." }, { status: 400 })
      const h = await readHeadForStaff(params.id)
      if (!v.isHtmlFile(h.name, h.mimeType)) return NextResponse.json({ error: "This is not an HTML file." }, { status: 400 })
      if ((h.size ?? h.head.length) > v.HTML_PAGE_MAX_BYTES) return NextResponse.json({ error: "This page is too large to show here — download it instead." }, { status: 413 })
      const f = await readFileForStaff(params.id)
      return new NextResponse(new Uint8Array(f.bytes), { headers: HTML_PAGE_HEADERS })
    }
    // everything else: ONE decision in viewPageFor — always a page (the file's own view, or the details page), never "cannot be shown"
    const input = versionId
      ? await (async () => { const f = await readVersionForStaff(params.id, versionId); return { name: f.name, mimeType: f.mimeType, size: f.bytes.length, head: f.bytes.subarray(0, VIEW_HEAD_BYTES), full: async () => f.bytes } })()
      : await (async () => { const h = await readHeadForStaff(params.id, VIEW_HEAD_BYTES); return { name: h.name, mimeType: h.mimeType, size: h.size, head: h.head, full: async () => (await readFileForStaff(params.id)).bytes } })()
    const { html } = await viewPageFor(input)
    return new NextResponse(html, { headers: HEADERS })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? `The file could not be shown (${e.message}) — download it instead.` : "The file is not available." }, { status: 404 })
  }
}
