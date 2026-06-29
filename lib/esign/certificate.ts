/**
 * E-Sign Certificate of Completion — the ESIGN/UETA legal artifact appended to
 * the signed PDF when an envelope completes. Lists, per signer, who signed, when
 * (UTC), from what IP + device, the consent acknowledgment, and the signature
 * hash; plus the document hash that proves which document was signed.
 *
 * Drawn with the Unicode font (handles accented names / €), never StandardFonts.
 * `appendCertificatePage` is pure (takes data, mutates the doc) — unit-tested.
 */

import { rgb, type PDFDocument, type PDFFont } from "pdf-lib"

export interface CertificateSigner {
  name: string
  email: string | null
  signedByName: string | null
  signedAt: string | null
  ip: string | null
  userAgent: string | null
  consent: boolean
  signatureHash?: string | null
}

export interface CertificateInfo {
  envelopeId: string
  documentName: string
  documentSha256: string
  completedAt: string
  consentText: string
  signers: CertificateSigner[]
}

/** Greedy word-wrap to a character budget (monospace-ish estimate; good enough
 *  for the cert). A single word longer than the budget (e.g. a pathological
 *  300-char no-space token in a signer name) is HARD-split into chunks so it
 *  wraps instead of overflowing off the page edge. */
export function wrapText(text: string, maxChars: number): string[] {
  const budget = Math.max(1, maxChars)
  const words = (text || "").split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let cur = ""
  for (const raw of words) {
    let w = raw
    while (w.length > budget) {
      if (cur) { lines.push(cur); cur = "" }
      lines.push(w.slice(0, budget))
      w = w.slice(budget)
    }
    if (!w) continue
    if (!cur) cur = w
    else if ((cur + " " + w).length <= budget) cur += " " + w
    else {
      lines.push(cur)
      cur = w
    }
  }
  if (cur) lines.push(cur)
  return lines.length ? lines : [""]
}

/** Append a Certificate of Completion page to an existing PDFDocument. */
export async function appendCertificatePage(pdf: PDFDocument, info: CertificateInfo): Promise<void> {
  const { embedUnicodeFonts } = await import("@/lib/pdf/unicode-fonts")
  const { regular, bold } = await embedUnicodeFonts(pdf)
  const page = pdf.addPage([612, 792])
  const margin = 54
  const bottom = margin
  let y = 792 - margin
  const ink = rgb(0.12, 0.12, 0.12)
  const muted = rgb(0.4, 0.4, 0.4)

  const draw = (
    text: string,
    opts: { size?: number; bold?: boolean; x?: number; gap?: number; color?: ReturnType<typeof rgb> } = {},
  ) => {
    if (y < bottom) return // never overflow the page (TD-first = 1 signer; guard anyway)
    const size = opts.size ?? 10
    const font: PDFFont = opts.bold ? bold : regular
    page.drawText(text, { x: opts.x ?? margin, y, size, font, color: opts.color ?? ink })
    y -= opts.gap ?? size + 6
  }

  draw("Certificate of Completion", { size: 18, bold: true, gap: 24 })
  draw("Electronic Signature — Tony Durante LLC", { size: 10, color: muted, gap: 22 })

  draw(`Document: ${info.documentName}`, { bold: true })
  draw(`Envelope ID: ${info.envelopeId}`, { color: muted, size: 9 })
  draw(`Completed (UTC): ${info.completedAt}`, { color: muted, size: 9 })
  draw(`Document SHA-256: ${info.documentSha256}`, { color: muted, size: 7 })
  y -= 8

  draw("Signers", { size: 13, bold: true, gap: 18 })
  for (const s of info.signers) {
    draw(`• ${s.signedByName || s.name}${s.email ? `   <${s.email}>` : ""}`, { bold: true })
    draw(`Signed (UTC): ${s.signedAt ?? "—"}`, { x: margin + 14, size: 9, color: muted })
    draw(`IP address: ${s.ip ?? "—"}`, { x: margin + 14, size: 9, color: muted })
    draw(`Device: ${(s.userAgent ?? "—").slice(0, 95)}`, { x: margin + 14, size: 8, color: muted })
    draw(`Consent: ${s.consent ? "Accepted" : "NOT recorded"}`, { x: margin + 14, size: 9, color: muted })
    if (s.signatureHash) draw(`Signature SHA-256: ${s.signatureHash}`, { x: margin + 14, size: 7, color: muted })
    y -= 8
  }

  y -= 4
  draw("Consent statement", { size: 11, bold: true, gap: 16 })
  for (const ln of wrapText(info.consentText, 95)) draw(ln, { size: 9, color: muted })
}
