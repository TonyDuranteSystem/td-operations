import { describe, it, expect } from "vitest"
import {
  resolveRepoPath,
  looksBinary,
  readCodebaseFile,
  searchCodebase,
} from "@/lib/mcp/tools/codebase-read"

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

describe("readCodebaseFile (extracted, shared by MCP tool + Hermes worker)", () => {
  it("reads a real repo file with line numbers", async () => {
    const out = await readCodebaseFile("package.json")
    expect(out).toContain("# package.json")
    expect(out).toMatch(/\n1\t/) // line-numbered output
  })

  it("returns a not-found message for a missing file", async () => {
    const out = await readCodebaseFile("lib/this-file-does-not-exist.ts")
    expect(out).toContain("File not found")
  })

  it("refuses a blocked path (no read)", async () => {
    const out = await readCodebaseFile(".env.local")
    expect(out).toContain("❌")
    expect(out).not.toContain("# .env.local")
  })
})

describe("searchCodebase (extracted, shared by MCP tool + Hermes worker)", () => {
  it("finds matches in a scoped directory", async () => {
    const out = await searchCodebase("readCodebaseFile", "lib/mcp/tools")
    expect(out).toContain("codebase-read.ts")
  })

  it("returns (no matches) for an absent string", async () => {
    const out = await searchCodebase("zzz_string_that_should_never_appear_zzz", "lib/mcp/tools")
    expect(out).toBe("(no matches)")
  })

  it("rejects an invalid regex pattern", async () => {
    const out = await searchCodebase("(unclosed", "lib/mcp/tools")
    expect(out).toContain("Invalid search pattern")
  })
})
