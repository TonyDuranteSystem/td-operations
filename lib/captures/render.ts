/**
 * Capture/Share feature — turning part (or all) of the current CRM page into
 * an image. Browser-only.
 *
 * Uses html2canvas DIRECTLY rather than going through html2pdf.js's own
 * higher-level Worker API, even though html2pdf.js is the existing, proven
 * "page to picture" tool this codebase already uses for contract/lease
 * signing. Verified against html2pdf.js's real source
 * (node_modules/html2pdf.js/src/worker.js): its Worker clones the target into
 * a NEW offscreen container sized to a PDF PAGE (jsPDF format), not the real
 * on-screen viewport — exactly wrong for "capture what's actually on screen,
 * where the user just tapped." html2canvas itself (the same rendering engine
 * html2pdf.js already depends on and this codebase already has CORS-configured
 * via `useCORS: true` on every existing call site) natively supports cropping
 * to an x/y/width/height region in real viewport coordinates, which is what
 * this feature actually needs — so this is the more correct way to reuse the
 * same proven engine, not a divergence from it.
 */
import html2canvas from "html2canvas"
import type { CaptureRect } from "./selection"

/**
 * Any element carrying this attribute (or with an ancestor carrying it) is
 * excluded from the render — the Capture tool's OWN panel/overlay must never
 * end up inside the picture it produces. Found live, 2026-09-04: capturing
 * "whole page" while the mode-choice panel was still on screen captured the
 * panel itself. CaptureLayer tags its own root with this attribute.
 */
export const CAPTURE_TOOL_IGNORE_ATTR = "data-capture-tool-ui"
const IGNORE_ATTR = CAPTURE_TOOL_IGNORE_ATTR

const HTML2CANVAS_OPTIONS = {
  useCORS: true, // matches every existing html2pdf.js call site in this codebase
  logging: false,
  backgroundColor: "#ffffff",
  ignoreElements: (element: Element) => element.closest(`[${IGNORE_ATTR}]`) !== null,
}

/** Renders the whole scrollable page (not just the visible viewport). */
export async function captureWholePage(): Promise<HTMLCanvasElement> {
  return html2canvas(document.body, {
    ...HTML2CANVAS_OPTIONS,
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
    windowWidth: document.documentElement.scrollWidth,
    windowHeight: document.documentElement.scrollHeight,
  })
}

/** Renders just the selected region, in the same coordinate space the user tapped in (current scroll position). */
export async function captureRegion(rect: CaptureRect): Promise<HTMLCanvasElement> {
  return html2canvas(document.body, {
    ...HTML2CANVAS_OPTIONS,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    // Negative scroll offsets are html2canvas's documented way of telling it
    // "the page is already scrolled this far — render relative to that",
    // so a selection made after scrolling down still captures the right pixels.
    scrollX: -window.scrollX,
    scrollY: -window.scrollY,
    windowWidth: document.documentElement.clientWidth,
    windowHeight: document.documentElement.clientHeight,
  })
}

export function canvasToPngFile(canvas: HTMLCanvasElement, fileName: string): Promise<File> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Could not turn the capture into an image. Please try again."))
        return
      }
      resolve(new File([blob], fileName, { type: "image/png" }))
    }, "image/png")
  })
}

/**
 * Auto-generated title — CONTEXT ONLY (page name, current time), never from
 * reading the captured image's own pixels. UX review, 2026-09-04: a title
 * generator that reads the image itself risks writing a just-redacted number
 * right back into the title with no human check step.
 */
export function generateCaptureTitle(pageLabel?: string): string {
  const label = (pageLabel ?? (typeof document !== "undefined" ? document.title : "")).trim()
  const cleanLabel = label && label.toLowerCase() !== "td operations" ? label.split(/\s[-|]\s/)[0].trim() : "Capture"
  const when = new Date().toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
  return `${cleanLabel || "Capture"} — ${when}`
}
