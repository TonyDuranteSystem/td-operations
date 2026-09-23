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
import {
  checkEmailFrameStillValid,
  computeCompositeDraw,
  findOverlappingEmailFrameSnapshots,
  readEmailFrameCurrentState,
} from "./email-frame-composite"

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

/**
 * A finished capture, plus whether it's known to be missing something. Never
 * a hard error — an incomplete capture is still a real, usable picture, just
 * one where the user should know a piece of it may be missing rather than
 * silently trusting it (see `captureRegion`'s email-iframe compositing).
 */
export interface CaptureResult {
  canvas: HTMLCanvasElement
  incomplete: boolean
}

/** Renders the whole scrollable page (not just the visible viewport). */
export async function captureWholePage(): Promise<CaptureResult> {
  const canvas = await html2canvas(document.body, {
    ...HTML2CANVAS_OPTIONS,
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
    windowWidth: document.documentElement.scrollWidth,
    windowHeight: document.documentElement.scrollHeight,
  })
  // Deliberately does NOT composite email iframes the way captureRegion
  // does below — this function has its own separate, already-tracked,
  // not-yet-root-caused bug (silently fails on the Dashboard; see
  // docs/systems/captures.md Gotchas) with its own unresolved scroll/
  // coordinate questions. Building the iframe-compositing math on top of
  // that unrelated, already-broken coordinate handling would be building on
  // sand. Antonio's actual report and its live reproduction were both a
  // region capture — this stays exactly as it was.
  return { canvas, incomplete: false }
}

/**
 * Renders just the selected region, in the same coordinate space the user
 * tapped in (current scroll position).
 *
 * html2canvas's own cross-frame clone-and-paint silently produces a
 * near-blank render for some Inbox emails' HTML inside their sandboxed
 * iframe (confirmed live; see lib/captures/email-frame-composite.ts for the
 * full story and the two rounds of review this went through). When the
 * selected region overlaps one or more of those iframes, each is rendered
 * SEPARATELY, from its own document, and composited on top of the normal
 * page render — rather than trusting html2canvas to walk into it as part of
 * the outer page.
 */
export async function captureRegion(rect: CaptureRect): Promise<CaptureResult> {
  const scale = window.devicePixelRatio || 1
  const candidates = findOverlappingEmailFrameSnapshots(rect)

  const rendered = await html2canvas(document.body, {
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
    // Pinned explicitly (matches html2canvas's own default formula) so the
    // outer render and every per-iframe render below are guaranteed to share
    // the same scale — required for the composited pixels to line up.
    scale,
  })

  if (candidates.length === 0) {
    return { canvas: rendered, incomplete: false }
  }

  // html2canvas's OWN returned canvas silently refuses to be drawn ONTO —
  // confirmed live, 2026-09-23: a drawImage straight onto it makes no visible
  // change at all (no error, no exception, just a no-op), while the exact
  // same drawImage call onto a plain canvas WE create works correctly, and
  // the html2canvas canvas draws fine as a SOURCE (canvas.drawImage(rendered,
  // 0, 0) succeeds) — it only refuses to be a destination. Root cause not
  // pinned inside html2canvas's own internals; the fix is simply to never
  // mutate a third-party library's returned canvas in place. Copy it onto a
  // fresh canvas WE own, then composite each email iframe onto that.
  const canvas = document.createElement("canvas")
  canvas.width = rendered.width
  canvas.height = rendered.height
  const ctx = canvas.getContext("2d")
  let incomplete = !ctx
  if (ctx) ctx.drawImage(rendered, 0, 0)

  if (ctx) {
    for (const { iframe, snapshot } of candidates) {
      try {
        const body = iframe.contentDocument?.body
        if (!body) {
          incomplete = true
          continue
        }
        const iframeCanvas = await html2canvas(body, {
          useCORS: true,
          logging: false,
          backgroundColor: "#ffffff",
          scale,
        })
        // Re-verify immediately before compositing — never trust the
        // snapshot taken before this (possibly slow) render. If the email
        // was removed (collapsed, navigated away from) or changed identity
        // or geometry in the meantime, the outer canvas and this iframe's
        // canvas no longer describe the same moment — drop it rather than
        // paste in something that might be stale or belong to a different
        // conversation.
        const validity = checkEmailFrameStillValid(snapshot, readEmailFrameCurrentState(iframe))
        if (!validity.valid) {
          incomplete = true
          continue
        }
        const draw = computeCompositeDraw(snapshot.rect, rect, scale)
        if (!draw) {
          incomplete = true
          continue
        }
        ctx.drawImage(
          iframeCanvas,
          draw.src.x,
          draw.src.y,
          draw.src.width,
          draw.src.height,
          draw.dest.x,
          draw.dest.y,
          draw.dest.width,
          draw.dest.height,
        )
      } catch {
        incomplete = true
      }
    }
  }

  return { canvas, incomplete }
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
