/**
 * The caller key for saving a Gmail attachment into the CRM store.
 *
 * Gmail attachment ids are NOT stable between API calls (the same attachment gets a different id each time the message
 * is fetched), so a key built from the attachment id made every repeat save a new file ("name (2).pdf"). The key is now
 * the message id + the SHA-256 of the bytes + the file-name key: saving the same attachment again is "already saved".
 */
import { createHash } from "crypto"
import { storeNameKey } from "./rules"

export function gmailAttachmentCallerKey(messageId: string, bytes: Buffer, fileName: string): string {
  const sha = createHash("sha256").update(bytes).digest("hex")
  return `gmail-attachment:${messageId}:${sha}:${storeNameKey(fileName)}`
}
