/**
 * Validates a single folder or file NAME for the in-CRM storage system (v2).
 * Folder hierarchy here is real parent_id rows, not slash-delimited paths,
 * so a name must never contain a path separator or traversal sequence.
 */

const MAX_NAME_LENGTH = 255

export interface NameGuardResult {
  error: string | null
  name: string
}

export function validateStorageName(input: unknown): NameGuardResult {
  if (typeof input !== "string") return { error: "Name is required", name: "" }
  const trimmed = input.trim()
  if (!trimmed) return { error: "Name cannot be empty", name: "" }
  if (trimmed.length > MAX_NAME_LENGTH) return { error: `Name exceeds ${MAX_NAME_LENGTH} characters`, name: "" }
  if (trimmed.includes("/") || trimmed.includes("\\")) return { error: "Name cannot contain a slash", name: "" }
  if (trimmed === "." || trimmed === "..") return { error: "Invalid name", name: "" }
  if (trimmed.includes("\0")) return { error: "Invalid name", name: "" }
  return { error: null, name: trimmed }
}
