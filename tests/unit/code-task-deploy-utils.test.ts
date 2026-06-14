import { describe, it, expect } from "vitest"
import {
  codeTaskBranchName,
  repoWebUrlFromRemote,
  compareUrl,
  taskShortId,
  codeTaskWorktreePath,
  promoteTempBranch,
  promoteWorktreePath,
} from "../../scripts/mac-mini/deploy-utils.mjs"

describe("codeTaskBranchName", () => {
  it("builds code-task/<short>-<slug> from a uuid + title", () => {
    expect(codeTaskBranchName("7a3cafa5-a0fb-4178-908b-2968deb725d0", "Fix the ITIN cron")).toBe(
      "code-task/7a3cafa5-fix-the-itin-cron",
    )
  })

  it("lowercases, collapses non-alphanumerics, trims hyphens", () => {
    expect(codeTaskBranchName("abcd1234", "  Add  P&L!! report  ")).toBe("code-task/abcd1234-add-p-l-report")
  })

  it("caps the slug length", () => {
    const b = codeTaskBranchName("abcd1234", "x".repeat(100))
    expect(b.length).toBeLessThanOrEqual("code-task/abcd1234-".length + 40)
    expect(b.startsWith("code-task/abcd1234-")).toBe(true)
  })

  it("falls back to code-task/<short> when the title has no usable chars", () => {
    expect(codeTaskBranchName("abcd1234", "!!!")).toBe("code-task/abcd1234")
    expect(codeTaskBranchName("abcd1234", "")).toBe("code-task/abcd1234")
    expect(codeTaskBranchName("abcd1234", null)).toBe("code-task/abcd1234")
  })

  it("falls back to 'task' when the id has no alphanumerics", () => {
    expect(codeTaskBranchName("----", "hello")).toBe("code-task/task-hello")
    expect(codeTaskBranchName(null, "hello")).toBe("code-task/task-hello")
  })

  it("produces no spaces, double hyphens, or trailing hyphen", () => {
    const b = codeTaskBranchName("ZZ99zz99", "a -- b -- c -- ")
    expect(b).not.toMatch(/\s/)
    expect(b).not.toMatch(/--/)
    expect(b).not.toMatch(/-$/)
  })
})

describe("repoWebUrlFromRemote", () => {
  it("parses ssh remotes", () => {
    expect(repoWebUrlFromRemote("git@github.com:TonyDuranteSystem/td-operations.git")).toBe(
      "https://github.com/TonyDuranteSystem/td-operations",
    )
  })

  it("parses https remotes with and without .git", () => {
    expect(repoWebUrlFromRemote("https://github.com/TonyDuranteSystem/td-operations.git")).toBe(
      "https://github.com/TonyDuranteSystem/td-operations",
    )
    expect(repoWebUrlFromRemote("https://github.com/TonyDuranteSystem/td-operations")).toBe(
      "https://github.com/TonyDuranteSystem/td-operations",
    )
  })

  it("strips an embedded token/user in https remotes", () => {
    expect(repoWebUrlFromRemote("https://x-access-token:abc@github.com/Org/Repo.git")).toBe(
      "https://github.com/Org/Repo",
    )
  })

  it("trims surrounding whitespace (git remote get-url adds a newline)", () => {
    expect(repoWebUrlFromRemote("git@github.com:Org/Repo.git\n")).toBe("https://github.com/Org/Repo")
  })

  it("returns null for unparseable / empty input", () => {
    expect(repoWebUrlFromRemote("")).toBeNull()
    expect(repoWebUrlFromRemote(null)).toBeNull()
    expect(repoWebUrlFromRemote("not a url")).toBeNull()
  })
})

describe("taskShortId", () => {
  it("takes the first 8 alphanumerics of a uuid", () => {
    expect(taskShortId("7a3cafa5-a0fb-4178-908b-2968deb725d0")).toBe("7a3cafa5")
  })
  it("falls back to 'task' when there are no alphanumerics", () => {
    expect(taskShortId("----")).toBe("task")
    expect(taskShortId(null)).toBe("task")
  })
  it("matches the short token used by the branch name", () => {
    const id = "abcd1234-aaaa-bbbb-cccc-dddddddddddd"
    expect(codeTaskBranchName(id, "x").startsWith(`code-task/${taskShortId(id)}`)).toBe(true)
  })
})

describe("codeTaskWorktreePath", () => {
  it("places the worktree under the repo's .claude/worktrees dir, keyed by task short id", () => {
    expect(codeTaskWorktreePath("/Users/x/td-operations", "7a3cafa5-a0fb-4178-908b-2968deb725d0")).toBe(
      "/Users/x/td-operations/.claude/worktrees/code-task-7a3cafa5",
    )
  })
  it("normalizes a trailing slash on the repo dir", () => {
    expect(codeTaskWorktreePath("/Users/x/td-operations/", "abcd1234")).toBe(
      "/Users/x/td-operations/.claude/worktrees/code-task-abcd1234",
    )
  })
})

describe("promoteTempBranch / promoteWorktreePath", () => {
  it("derives a safe temp branch from a code branch", () => {
    expect(promoteTempBranch("code-task/abcd1234-fix-itin")).toBe("promote/code-task-abcd1234-fix-itin")
  })
  it("derives a worktree path under .claude/worktrees", () => {
    expect(promoteWorktreePath("/Users/x/td-operations", "code-task/abcd1234-fix-itin")).toBe(
      "/Users/x/td-operations/.claude/worktrees/promote-code-task-abcd1234-fix-itin",
    )
  })
  it("falls back to 'branch' for empty input", () => {
    expect(promoteTempBranch("")).toBe("promote/branch")
    expect(promoteTempBranch(null)).toBe("promote/branch")
  })
})

describe("compareUrl", () => {
  it("builds a compare URL keeping the branch slash literal", () => {
    expect(
      compareUrl("https://github.com/Org/Repo", "code-task/abcd1234-fix-itin"),
    ).toBe("https://github.com/Org/Repo/compare/main...code-task/abcd1234-fix-itin?expand=1")
  })

  it("returns null without a web base or branch", () => {
    expect(compareUrl(null, "code-task/x")).toBeNull()
    expect(compareUrl("https://github.com/Org/Repo", "")).toBeNull()
  })
})
