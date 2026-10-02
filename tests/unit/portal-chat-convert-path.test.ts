import { describe, it, expect } from "vitest"
import { convertibleChatPath, jpegPathBeside } from "@/lib/portal/chat-attachment-path"

const id = "123e4567-e89b-12d3-a456-426614174000"
describe("convertibleChatPath", () => {
  it("accepts only an iPhone photo the uploader made for this thread", () => {
    expect(convertibleChatPath(`chat-attachments/acc1/${id}.heic`, "acc1", null)).toBe(true)
    expect(convertibleChatPath(`chat-attachments/acc1/${id}.heif`, "acc1", null)).toBe(true)
    expect(convertibleChatPath(`chat-attachments/c9/${id}.heic`, null, "c9")).toBe(true)
  })
  it("refuses another thread, other types, odd paths and traversal", () => {
    expect(convertibleChatPath(`chat-attachments/acc2/${id}.heic`, "acc1", null)).toBe(false)
    expect(convertibleChatPath(`chat-attachments/acc1/${id}.pdf`, "acc1", null)).toBe(false)
    expect(convertibleChatPath(`other/acc1/${id}.heic`, "acc1", null)).toBe(false)
    expect(convertibleChatPath(`chat-attachments/acc1/../x/${id}.heic`, "acc1", null)).toBe(false)
    expect(convertibleChatPath(`chat-attachments/acc1/notauuid.heic`, "acc1", null)).toBe(false)
  })
})
describe("jpegPathBeside", () => {
  it("stays in the same folder with a new name and a .jpg ending", () => {
    const p = jpegPathBeside(`chat-attachments/acc1/${id}.heic`)
    expect(p).toMatch(/^chat-attachments\/acc1\/[0-9a-f-]{36}\.jpg$/)
    expect(p).not.toContain(id)
  })
})
