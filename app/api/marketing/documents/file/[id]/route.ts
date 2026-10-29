export const dynamic = "force-dynamic"
import { NextRequest, NextResponse } from "next/server"
import { docsGate, docsError, json, isUuid } from "@/lib/marketing/documents-route"
import { readDoc, renameDoc, trashDoc, DocsError } from "@/lib/marketing/documents-server"
import { staffFileHeaders, canPreviewInline } from "@/lib/crm-store/serve"

const SIMPLE_VIEW_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "private, no-store",
}

/** GET — the document as a download; with ?view=1 a PDF, image, text, Word or Excel file opens in the browser (a new tab) instead. PowerPoint, old .doc/.xls and anything else is still a download. */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const g = await docsGate(req, "read")
  if (g.res) return g.res
  if (!isUuid(params.id)) return docsError(new DocsError("That document was not found.", 404), "")
  try {
    const f = await readDoc(params.id)
    const h = staffFileHeaders(f.mimeType, f.name)
    if (req.nextUrl.searchParams.get("view") === "1") {
      if (canPreviewInline(f.mimeType)) {
        // shown inside the browser, locked down: a PDF needs Chromium's own viewer (no sandbox header there); images and text stay sandboxed
        return new NextResponse(new Uint8Array(f.bytes), { headers: h["Content-Type"] === "application/pdf" ? h : { ...h, "Content-Security-Policy": "sandbox" } })
      }
      // Word / Excel / text-like files: the CRM storage's own "simplified view" (one script-free page; the same reader and the same limits as the Storage screen)
      const v = await import("@/lib/crm-store/view-html")
      const kind = v.viewKindFor(f.name, f.mimeType)
      if (kind && f.bytes.length <= v.VIEW_MAX_BYTES[kind]) {
        const html = kind === "docx" ? await v.docxToViewHtml(f.name, f.bytes) : kind === "xlsx" ? await v.xlsxToViewHtml(f.name, f.bytes) : v.renderTextView(f.name, f.bytes.toString("utf-8"))
        return new NextResponse(html, { headers: SIMPLE_VIEW_HEADERS })
      }
    }
    return new NextResponse(new Uint8Array(f.bytes), { headers: { ...h, "Content-Disposition": h["Content-Disposition"].replace(/^inline/, "attachment") } })
  } catch (e) { return docsError(e, "That document could not be downloaded. Please try again.") }
}

/** PATCH { name } — rename. */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const g = await docsGate(req, "manage")
  if (g.res) return g.res
  const b = await req.json().catch(() => ({})) as { name?: unknown }
  if (!isUuid(params.id) || typeof b.name !== "string" || !b.name.trim()) return docsError(new DocsError("Type a new name."), "")
  try { return json(await renameDoc(params.id, b.name, g.ctx.user.id)) } catch (e) { return docsError(e, "The document could not be renamed. Please try again.") }
}

/** DELETE — to the storage's trash (the Storage page can bring it back). */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const g = await docsGate(req, "manage")
  if (g.res) return g.res
  if (!isUuid(params.id)) return docsError(new DocsError("That document was not found.", 404), "")
  try { await trashDoc(params.id, g.ctx.user.id); return json({ ok: true }) } catch (e) { return docsError(e, "The document could not be deleted. Please try again.") }
}
