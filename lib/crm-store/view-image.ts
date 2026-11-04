/**
 * A picture a browser may not draw (SVG, TIFF, AVIF …) as a PNG for the simplified view. SERVER ONLY: it uses `sharp`, which must never be
 * pulled into the screen's bundle (that is why it is not in view-html.ts, which the Storage and Marketing screens import). SVG is
 * rasterised, so nothing inside it can run.
 */
import { wrapPage, dataImg } from "./view-html"

export async function imageToViewHtml(title: string, bytes: Buffer): Promise<string> {
  const sharp = (await import("sharp")).default
  const png = await sharp(bytes, { limitInputPixels: 120_000_000 }).rotate().resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true }).png().toBuffer()
  return wrapPage(title, dataImg("image/png", png), "Picture converted for the screen — download the original for the exact file.")
}
