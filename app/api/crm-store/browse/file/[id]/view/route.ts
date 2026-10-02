/**
 * GET /api/crm-store/browse/file/<id>/view — a "simplified view" of the file's CURRENT version for the storage screen (2026-10-02):
 * Word → readable page, Excel → tables, Markdown / CSV / JSON … → text. One self-contained HTML page, served with a CSP that forbids
 * every script and a sandbox, so a hostile document cannot run anything. Same staff + storage-access checks as the plain file route;
 * nothing is written anywhere. Anything else (PDF and pictures have their own viewer; PowerPoint, old .doc/.xls) is a 415 → download.
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

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const noAccess = await denyUnlessAreaAccess({ fileId: params.id }, { allowSharedRead: true })
  if (noAccess) return noAccess
  try {
    const { readFileForStaff } = await import("@/lib/crm-store/browse")
    const v = await import("@/lib/crm-store/view-html")
    const f = await readFileForStaff(params.id)
    const kind = v.viewKindFor(f.name, f.mimeType)
    if (!kind) return NextResponse.json({ error: "This kind of file cannot be shown here — download it instead." }, { status: 415 })
    if (f.bytes.length > v.VIEW_MAX_BYTES[kind]) return NextResponse.json({ error: `This file is too large to show here (${Math.round(f.bytes.length / 1048576)} MB) — download it instead.` }, { status: 413 })
    const html = kind === "docx" ? await v.docxToViewHtml(f.name, f.bytes)
      : kind === "xlsx" ? await v.xlsxToViewHtml(f.name, f.bytes)
      : v.renderTextView(f.name, f.bytes.toString("utf-8"))
    return new NextResponse(html, { headers: HEADERS })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? `The file could not be shown (${e.message}) — download it instead.` : "The file is not available." }, { status: 404 })
  }
}
