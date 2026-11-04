/**
 * Playing a video or an audio file inside the storage screen (Antonio 2026-11-04: a Zoom recording "can't be opened inside").
 * A recording can be hundreds of MB, so the server never loads it: it hands the screen a short-lived signed link straight to the
 * stored object and the browser's own player streams it (and can jump around in it). Only staff who pass the usual storage checks
 * get a link, and a link is only made for the current copy of one file. A <video> / <audio> element cannot run script.
 */

export type MediaKind = "video" | "audio"

/** How long a signed link stays valid — long enough to watch a long call without it expiring mid-way. */
export const MEDIA_LINK_SECONDS = 3600

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|ogv)$/i
const AUDIO_EXT = /\.(m4a|mp3|wav|aac|oga|ogg|opus|flac|weba)$/i

/** Whether the file is something a browser player can try, by its name or its stored type; null = not a recording. */
export function mediaKindFor(name: string, mimeType: string | null | undefined): MediaKind | null {
  const mime = (mimeType ?? "").split(";")[0].trim().toLowerCase()
  if (VIDEO_EXT.test(name) || mime.startsWith("video/")) return "video"
  if (AUDIO_EXT.test(name) || mime.startsWith("audio/")) return "audio"
  return null
}

/** Files above this size are downloaded straight from storage (the server never loads them into memory). */
export const BIG_DOWNLOAD_BYTES = 8 * 1024 * 1024

export const HTML_RE = /\.(html?|xhtml)$/i
export const HTML_PAGE_MAX_BYTES = 10 * 1024 * 1024
/** An HTML file (a saved mockup): can be shown as the real page inside a locked box. */
export const isHtmlFile = (name: string, mimeType: string | null | undefined): boolean => HTML_RE.test(name) || (mimeType ?? "").split(";")[0].trim().toLowerCase() === "text/html"
