/**
 * A PDF on a phone (Antonio, 2026-11-24): inside a frame the iPhone's engine shows page 1 only, so a touch phone gets an "Open PDF" button that opens the
 * file as its own page; a computer keeps the frame exactly as before.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { PDF_PHONE_QUERY, pdfModeFor } from "@/lib/ui/pdf-view-rules"

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

describe("which way a PDF is shown", () => {
  it("a touch screen with no mouse opens the PDF as its own page; a computer keeps the frame", () => {
    expect(pdfModeFor(true)).toBe("open")
    expect(pdfModeFor(false)).toBe("frame")
  })
  it("before the screen has asked, nothing is drawn (a phone must not start downloading the file into a frame it cannot show)", () => {
    expect(pdfModeFor(null)).toBe("checking")
  })
  it("the question is 'no hover and a coarse pointer' — a capability, not a browser name (Chrome and Safari on iPhone behave the same)", () => {
    expect(PDF_PHONE_QUERY).toBe("(hover: none) and (pointer: coarse)")
  })
})

describe("wiring", () => {
  const view = read("components/ui/pdf-view.tsx")
  const store = read("components/storage/new-store-browser.tsx")
  it("the computer path is the same frame as before, with the same address, title and classes", () => {
    expect(view).toContain("<iframe src={src} title={title} className={className} />")
  })
  it("the phone path is a real link that opens in a new page, with a plain 'Open PDF' button and a way back", () => {
    expect(view).toContain("href={src}")
    expect(view).toContain('target="_blank"')
    expect(view).toContain("Open PDF")
    expect(view).toContain("close it or go back to return here")
  })
  it("it follows the screen if the device changes (a tablet with a keyboard attached)", () => {
    expect(view).toContain("mq.addEventListener('change', on)")
    expect(view).toContain("mq.removeEventListener('change', on)")
  })
  it("Storage's preview uses it for PDFs only; text keeps its frame", () => {
    expect(store).toContain("import { PdfView } from '@/components/ui/pdf-view'")
    expect(store).toContain("mime === 'application/pdf' ? (")
    expect(store).toContain('<PdfView src={src} title={file.name} className="h-full w-full border-0" />')
    expect(store).toContain('<iframe src={src} title={file.name} className="h-full w-full border-0" />')
  })
  it("the legacy sandboxed viewers, the signing pages and the client portal are NOT touched by this change", () => {
    expect(read("components/storage/file-preview-modal.tsx")).not.toContain("PdfView")
    expect(read("components/ui/floating-document-window.tsx")).not.toContain("PdfView")
    expect(read("components/portal/document-list.tsx")).not.toContain("PdfView")
  })
})
