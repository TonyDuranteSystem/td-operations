import { describe, it, expect } from "vitest"
import { resolveRepoPath, looksBinary } from "@/lib/mcp/tools/codebase-read"

describe("resolveRepoPath (codebase_read/search path gate)", () => {
  it("allows normal source paths inside the repo", () => {
    expect(resolveRepoPath("app/(dashboard)/finance/clients-invoices-tab.tsx").ok).toBe(true)
    expect(resolveRepoPath("lib/portal/td-invoice.ts").ok).toBe(true)
    expect(resolveRepoPath("components/ui/button.tsx").ok).toBe(true)
  })

  it("rejects path traversal escapes", () => {
    expect(resolveRepoPath("../../etc/passwd").ok).toBe(false)
    expect(resolveRepoPath("lib/../../secret").ok).toBe(false)
  })

  it("rejects absolute paths outside the repo", () => {
    expect(resolveRepoPath("/etc/passwd").ok).toBe(false)
  })

  it("rejects env / secret / credential files", () => {
    expect(resolveRepoPath(".env").ok).toBe(false)
    expect(resolveRepoPath(".env.local").ok).toBe(false)
    expect(resolveRepoPath("config/secrets/keys.json").ok).toBe(false)
    expect(resolveRepoPath("certs/server.pem").ok).toBe(false)
    expect(resolveRepoPath("a/b/private.key").ok).toBe(false)
  })

  it("rejects build/deps/vcs paths", () => {
    expect(resolveRepoPath("node_modules/react/index.js").ok).toBe(false)
    expect(resolveRepoPath(".git/config").ok).toBe(false)
    expect(resolveRepoPath(".next/server/app.js").ok).toBe(false)
    expect(resolveRepoPath(".vercel/project.json").ok).toBe(false)
  })

  it("rejects empty input", () => {
    expect(resolveRepoPath("").ok).toBe(false)
  })
})

describe("looksBinary", () => {
  it("flags buffers with NUL bytes", () => {
    expect(looksBinary(Buffer.from([0x48, 0x00, 0x49]))).toBe(true)
  })
  it("treats normal text as non-binary", () => {
    expect(looksBinary(Buffer.from("export const x = 1\nconst y = 2\n", "utf8"))).toBe(false)
  })
})
