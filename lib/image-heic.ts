/**
 * iPhone photos (HEIC / HEIF). Browsers other than Safari and Google Document AI cannot read them, so anything that has to READ or SHOW
 * one converts it to a JPEG first — the stored original is never touched (Antonio 2026-10-02: "I want these formats to be read").
 * `heic-convert` is pure JavaScript (no native binary); sharp cannot open HEIC (measured 2026-09-30).
 */
export function looksLikeHeic(name: string, mimeType: string | null, bytes: Buffer): boolean {
  const m = (mimeType ?? "").split(";")[0].trim().toLowerCase()
  if (m === "image/heic" || m === "image/heif" || m === "image/heic-sequence" || m === "image/heif-sequence") return true
  if (/\.(heic|heif)$/i.test(name)) return true
  // the file signature: bytes 4–11 are "ftyp" plus a HEIF brand
  if (bytes.length > 12 && bytes.toString("ascii", 4, 8) === "ftyp") {
    return /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(bytes.toString("ascii", 8, 12))
  }
  return false
}

export async function heicToJpeg(bytes: Buffer): Promise<Buffer> {
  const convert = (await import("heic-convert")).default as (o: { buffer: Buffer; format: "JPEG" | "PNG"; quality?: number }) => Promise<ArrayBuffer>
  return Buffer.from(await convert({ buffer: bytes, format: "JPEG", quality: 0.92 }))
}

/** What a reader (OCR, AI) should be given: the same bytes, or — for HEIC — a JPEG made from them. */
export async function readableImage(
  bytes: Buffer, mimeType: string, name: string, convert: (b: Buffer) => Promise<Buffer> = heicToJpeg,
): Promise<{ bytes: Buffer; mimeType: string; converted: boolean }> {
  if (!looksLikeHeic(name, mimeType, bytes)) return { bytes, mimeType, converted: false }
  return { bytes: await convert(bytes), mimeType: "image/jpeg", converted: true }
}
