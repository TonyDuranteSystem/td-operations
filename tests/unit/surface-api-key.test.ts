import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { surfaceApiKeyOverride, surfaceKeyEnvName } from "@/lib/ai-agent/surface-api-key"

/**
 * Which key each assistant surface runs on — the 2026-07-29 outage contract.
 *
 * Team Chat was hardwired in code to SLACK_WORKER_ANTHROPIC_KEY, so disabling the
 * Slack key at Anthropic took Team Chat down with it ("Claude in td-taxreturn
 * doesn't work", every request erroring). These tests pin the decoupling: a
 * surface's key is env config named FOR that surface, the legacy Slack name feeds
 * ONLY the slack surface, and no key at all means the shared-key fallback.
 */

const VARS = ["WORKER_KEY_TEAM_CHAT", "WORKER_KEY_SLACK", "SLACK_WORKER_ANTHROPIC_KEY"]
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const v of VARS) {
    saved[v] = process.env[v]
    delete process.env[v]
  }
})
afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v]
    else process.env[v] = saved[v]
  }
})

describe("surfaceKeyEnvName", () => {
  it("derives the env name from the surface", () => {
    expect(surfaceKeyEnvName("team_chat")).toBe("WORKER_KEY_TEAM_CHAT")
    expect(surfaceKeyEnvName("slack")).toBe("WORKER_KEY_SLACK")
    expect(surfaceKeyEnvName("portal-chats")).toBe("WORKER_KEY_PORTAL_CHATS")
  })
})

describe("surfaceApiKeyOverride", () => {
  it("returns undefined when nothing is configured — the shared-key fallback", () => {
    expect(surfaceApiKeyOverride("team_chat")).toBeUndefined()
    expect(surfaceApiKeyOverride("slack")).toBeUndefined()
  })

  it("THE OUTAGE: the legacy Slack key must NOT feed team_chat", () => {
    process.env.SLACK_WORKER_ANTHROPIC_KEY = "sk-slack-legacy"
    // Slack keeps its dedicated key…
    expect(surfaceApiKeyOverride("slack")).toBe("sk-slack-legacy")
    // …but Team Chat no longer inherits it. Disabling the Slack key can then
    // never take Team Chat down again.
    expect(surfaceApiKeyOverride("team_chat")).toBeUndefined()
  })

  it("a surface's own env var wins over the legacy name", () => {
    process.env.SLACK_WORKER_ANTHROPIC_KEY = "sk-slack-legacy"
    process.env.WORKER_KEY_SLACK = "sk-slack-new"
    expect(surfaceApiKeyOverride("slack")).toBe("sk-slack-new")
  })

  it("an empty or whitespace value counts as unset — never breaks the fallback", () => {
    process.env.WORKER_KEY_TEAM_CHAT = "   "
    expect(surfaceApiKeyOverride("team_chat")).toBeUndefined()
    process.env.SLACK_WORKER_ANTHROPIC_KEY = ""
    expect(surfaceApiKeyOverride("slack")).toBeUndefined()
  })

  it("reads env at call time, so a config change needs no redeploy of behaviour", () => {
    expect(surfaceApiKeyOverride("team_chat")).toBeUndefined()
    process.env.WORKER_KEY_TEAM_CHAT = "sk-team"
    expect(surfaceApiKeyOverride("team_chat")).toBe("sk-team")
  })
})
