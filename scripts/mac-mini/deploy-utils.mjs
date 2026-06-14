/**
 * Pure helpers for the code-task safe-deploy flow (Slack → Mac Mini rail).
 *
 * The runner no longer auto-pushes a code task's commits to `main`/production.
 * Instead it moves them onto a per-task BRANCH and pushes the branch for review
 * (R104 — production deploy is a separate, explicit "ship it" step). These pure
 * helpers build the branch name and the review URL. No I/O — unit-tested in
 * tests/unit/code-task-deploy-utils.test.ts.
 */

/**
 * Build a safe git branch name for a code task: `code-task/<short>-<slug>`.
 *   short = first 8 alphanumerics of the task id (uuid) — uniqueness + traceability.
 *   slug  = title lowercased, runs of non-alphanumerics collapsed to a single
 *           hyphen, trimmed, capped at 40 chars.
 * Always a valid git ref: no spaces, no leading/trailing/double hyphen, never
 * empty (falls back to `code-task/<short>` if the title has no usable chars).
 */
export function codeTaskBranchName(taskId, title) {
  const short = taskShortId(taskId)
  const slug = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "")
  return slug ? `code-task/${short}-${slug}` : `code-task/${short}`
}

/**
 * Short, collision-resistant token from a task id — first 8 alphanumerics of the
 * uuid, or "task" if none. Shared by the branch name and the worktree dir so a
 * branch and its worktree are always traceable to the same task.
 */
export function taskShortId(taskId) {
  return String(taskId || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "task"
}

/**
 * Absolute path of the isolated worktree for a task, under the repo's gitignored
 * `.claude/worktrees/` dir: `<repoDir>/.claude/worktrees/code-task-<short>`.
 * Each task gets its own directory so sessions never share a working tree.
 */
export function codeTaskWorktreePath(repoDir, taskId) {
  return `${String(repoDir || "").replace(/\/+$/, "")}/.claude/worktrees/code-task-${taskShortId(taskId)}`
}

/**
 * Convert a git remote URL to its https web base.
 *   git@github.com:Org/Repo.git      -> https://github.com/Org/Repo
 *   https://github.com/Org/Repo.git  -> https://github.com/Org/Repo
 *   https://user@github.com/Org/Repo  -> https://github.com/Org/Repo
 * Returns null when it can't be parsed.
 */
export function repoWebUrlFromRemote(remote) {
  const r = String(remote || "").trim()
  if (!r) return null
  let m = r.match(/^git@([^:]+):(.+?)(?:\.git)?$/)
  if (m) return `https://${m[1]}/${m[2]}`
  m = r.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?$/)
  if (m) return `https://${m[1]}/${m[2]}`
  return null
}

/**
 * GitHub compare / open-PR URL for a branch against main. Slashes in the branch
 * name (e.g. `code-task/...`) are kept literal. Returns null without a web base.
 */
export function compareUrl(repoWeb, branch) {
  if (!repoWeb || !branch) return null
  const safeBranch = encodeURIComponent(branch).replace(/%2F/g, "/")
  return `${repoWeb}/compare/main...${safeBranch}?expand=1`
}
