/**
 * Which inline renderer a CRM Storage file's mime type gets in the preview
 * modal. Kept in its own plain module (not inline in the component) so it's
 * a pure, directly unit-testable function — the component file is .tsx and
 * this project's test config doesn't run .tsx test files.
 */
export function previewKind(mimeType: string | null): "image" | "pdf" | "video" | "audio" | "text" | "none" {
  if (!mimeType) return "none"
  if (mimeType.startsWith("image/")) return "image"
  if (mimeType === "application/pdf") return "pdf"
  if (mimeType.startsWith("video/")) return "video"
  if (mimeType.startsWith("audio/")) return "audio"
  if (mimeType.startsWith("text/")) return "text"
  return "none"
}
