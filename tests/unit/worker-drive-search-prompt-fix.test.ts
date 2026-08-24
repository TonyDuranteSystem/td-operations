/**
 * Team Chat's and Portal Chats' worker prompts both falsely told the model that
 * search_documents (our own filed-document index) "includes Drive-stored client
 * records" — it does not; it only returns files already filed with us. That false
 * claim is why the assistant gave up and asked Luca where a real file was instead
 * of calling drive_search (Achievers Group LLC incident, dev job 77bd0e93). This
 * pins the correction: the false claim is gone, and the model is now told to
 * check drive_search before concluding a document does not exist.
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { buildWorkerSurfacePrompt } from "@/lib/ai-agent/inbox-worker-prompt"

const CLAUDE_TRIGGER_SRC = readFileSync(join(process.cwd(), "lib/team/claude-trigger.ts"), "utf8")

describe("Team Chat worker prompt (lib/team/claude-trigger.ts)", () => {
  it("no longer claims search_documents reaches Drive-stored records", () => {
    expect(CLAUDE_TRIGGER_SRC).not.toContain("that includes Drive-stored client records")
  })

  it("tells the model to fall back to drive_search before giving up", () => {
    expect(CLAUDE_TRIGGER_SRC).toContain("ALSO check drive_search before concluding the file does not exist")
    expect(CLAUDE_TRIGGER_SRC).toContain("you CANNOT attach it this way")
  })
})

describe("Portal Chats worker prompt (buildWorkerSurfacePrompt)", () => {
  it("no longer claims search_documents reaches Drive-stored records", () => {
    const prompt = buildWorkerSurfacePrompt("portal-chats")
    expect(prompt).not.toContain("that includes Drive-stored client records")
  })

  it("tells the model to fall back to drive_search before giving up", () => {
    const prompt = buildWorkerSurfacePrompt("portal-chats")
    expect(prompt).toContain("ALSO check drive_search before concluding the file does not exist")
    expect(prompt).toContain("you CANNOT attach it this way")
  })

  it("leaves the Inbox and CRM Assistant surfaces untouched — neither mentioned Drive to begin with", () => {
    expect(buildWorkerSurfacePrompt("inbox")).not.toContain("drive_search")
    expect(buildWorkerSurfacePrompt("dashboard")).not.toContain("drive_search")
  })
})
