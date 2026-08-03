#!/usr/bin/env node
/**
 * generate-system-atlas.mjs — regenerate the FACTUAL half of docs/systems/SYSTEM-ATLAS.md
 * from the live code, deterministically.
 *
 * WHY THIS EXISTS
 * The atlas was hand-written once (2026-05-29) and left. By 2026-08-02 it claimed 41 MCP
 * tool groups (live: 49), 18 hooks (live: 26), and a guardrail list stopping at R106 while
 * CLAUDE.md had reached R113. Nothing referenced it, nothing regenerated it, and it was not
 * mapped in the R107 doc-freshness gate — so it could not fail loudly. The System Counselor
 * is now told never to quote its numbers; that is a workaround, not a fix. This is the fix.
 *
 * DESIGN — generated sections only, curated prose preserved.
 * Everything between a pair of markers is rewritten; everything else is left exactly alone,
 * because the "what each system is and why it matters" prose is human knowledge a script
 * cannot produce. Markers:
 *     <!-- GENERATED:<name> --> ... <!-- /GENERATED:<name> -->
 *
 * Counting rules are the ones CLAUDE.md already declares authoritative — notably: the ONLY
 * source of truth for active MCP tools is the uncommented register*Tools calls in the
 * transport route, never a grep across all tool files (a file can exist unregistered).
 *
 * Usage:
 *   node scripts/generate-system-atlas.mjs            # rewrite the file in place
 *   node scripts/generate-system-atlas.mjs --check    # exit 1 if it is out of date (CI/pre-push)
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const ROOT = process.cwd();
const ATLAS = join(ROOT, "docs/systems/SYSTEM-ATLAS.md");
const CHECK = process.argv.includes("--check");

const read = (p) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), "utf8") : "");
const dirs = (p) => {
  const full = join(ROOT, p);
  if (!existsSync(full)) return [];
  return readdirSync(full)
    .filter((d) => !d.startsWith(".") && !d.startsWith("_") && statSync(join(full, d)).isDirectory())
    .sort();
};

// ── 1. MCP tools ────────────────────────────────────────────────────────────
// Source of truth per CLAUDE.md: uncommented register*Tools(server) in the transport route.
const route = read("app/api/[transport]/route.ts");
const routeNoBlockComments = route.replace(/\/\*[\s\S]*?\*\//g, "");
const activeGroups = [
  ...new Set(
    routeNoBlockComments
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n")
      .match(/register([A-Za-z0-9]+)Tools\s*\(\s*server\s*\)/g)
      ?.map((m) => m.replace(/register|Tools\s*\(\s*server\s*\)/g, "")) ?? []
  ),
].sort();

// Tool names, counted only from files that are actually registered is not statically
// resolvable (register fns live in many files); count distinct names across non-deprecated
// tool files and SAY that is what the number is.
const toolFiles = existsSync(join(ROOT, "lib/mcp/tools"))
  ? readdirSync(join(ROOT, "lib/mcp/tools")).filter((f) => f.endsWith(".ts"))
  : [];
const toolNames = new Set();
for (const f of toolFiles) {
  const src = read(`lib/mcp/tools/${f}`);
  for (const m of src.matchAll(/server\.tool\(\s*["'`]([a-z0-9_]+)["'`]/g)) toolNames.add(m[1]);
}

// ── 2. Hooks ────────────────────────────────────────────────────────────────
const hookFiles = existsSync(join(ROOT, ".claude/hooks"))
  ? readdirSync(join(ROOT, ".claude/hooks"))
      .filter((f) => (f.endsWith(".sh") || f.endsWith(".py")) && !f.startsWith("test-"))
      .sort()
  : [];
let registeredHooks = new Set();
try {
  const settings = JSON.parse(read(".claude/settings.json") || "{}");
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (o && typeof o === "object") {
      if (typeof o.command === "string") {
        for (const m of o.command.matchAll(/\.claude\/hooks\/([A-Za-z0-9._-]+)/g)) registeredHooks.add(m[1]);
      }
      Object.values(o).forEach(walk);
    }
  };
  walk(settings.hooks ?? {});
} catch { /* settings unreadable → leave empty, the count below says so */ }
// A hook can also be wired by ANOTHER hook (the .sh wrappers invoke the .py enforcement
// cores) or by a subagent's frontmatter. Missing these labelled 4 LIVE safety hooks as
// "not wired", including the System Counselor's read-only guard and r093_verifier.py.
{
  const refSources = [];
  for (const f of hookFiles) refSources.push(read(`.claude/hooks/${f}`));
  if (existsSync(join(ROOT, ".claude/agents")))
    for (const f of readdirSync(join(ROOT, ".claude/agents")).filter((x) => x.endsWith(".md")))
      refSources.push(read(`.claude/agents/${f}`));
  const blob = refSources.join("\n");
  for (const f of hookFiles) {
    // don't let a file count as wiring itself
    const others = refSources.filter((_, i) => hookFiles[i] !== f).join("\n");
    if (new RegExp(`[/"'\\s]${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(others) ||
        blob.includes(`/${f}`) && !registeredHooks.has(f)) {
      if (others.includes(f)) registeredHooks.add(f);
    }
  }
}

// ── 3. Guardrail rules (R-rules) from CLAUDE.md ─────────────────────────────
const claude = read("CLAUDE.md");
const rules = [];
for (const m of claude.matchAll(/^- \*\*(R\d+)\*\*\s*—\s*([^\n]+)$/gm)) {
  rules.push({ id: m[1], text: m[2].replace(/`/g, "").trim() });
}
rules.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));

// ── 4. Surface area ─────────────────────────────────────────────────────────
// A directory is only a "page" area if it actually contains a page file somewhere, and
// only a "route group" if it contains a route handler. Counting bare directories listed
// component folders as pages and hid every nested page.
const hasFile = (dir, names) => {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    const full = join(ROOT, cur);
    if (!existsSync(full)) continue;
    for (const e of readdirSync(full)) {
      const p = join(full, e);
      if (statSync(p).isDirectory()) stack.push(join(cur, e));
      else if (names.includes(e)) return true;
    }
  }
  return false;
};
const PAGE = ["page.tsx", "page.ts", "page.jsx"];
const ROUTE = ["route.ts", "route.tsx", "route.js"];
const dashPages = dirs("app/(dashboard)").filter((d) => hasFile(`app/(dashboard)/${d}`, PAGE));
const portalPages = dirs("app/portal").filter((d) => hasFile(`app/portal/${d}`, PAGE));
const apiGroups = dirs("app/api").filter((d) => hasFile(`app/api/${d}`, ROUTE));
const libModules = dirs("lib");

// ── 5. Database tables from the generated types ─────────────────────────────
const types = read("lib/database.types.ts");
let tableCount = 0;
const tblBlock = types.match(/Tables:\s*\{([\s\S]*?)\n {4}\}/);
if (tblBlock) tableCount = [...tblBlock[1].matchAll(/^ {6}([a-z0-9_]+):\s*\{/gm)].length;

// ── 6. Deep-doc index ───────────────────────────────────────────────────────
const sysDocs = existsSync(join(ROOT, "docs/systems"))
  ? readdirSync(join(ROOT, "docs/systems"))
      .filter((f) => f.endsWith(".md") && f !== "SYSTEM-ATLAS.md" && f !== "README.md")
      .sort()
  : [];
const docLine = (f) => {
  const src = read(`docs/systems/${f}`);
  const first = src.split("\n").find((l) => l.startsWith("# "));
  // Docs use TWO date styles and drifted between them: the template's
  // "_Last verified against code: DATE_" (optionally without the underscore or with
  // other emphasis) and a prepended changelog line "_DATE — Claude (…)_". Taking the
  // FIRST match reported formation.md as 6 weeks staler than it is and showed
  // error-auto-audit.md as having no date at all. Take the MAX of every date found in
  // a dated-header position, so freshness can only be under-claimed by a doc that
  // genuinely records nothing.
  const dates = [
    ...src.matchAll(/[_*]*\s*(?:Last verified against code|Prior|Latest|Earlier)\s*:?\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/gi),
    ...src.matchAll(/^_([0-9]{4}-[0-9]{2}-[0-9]{2})[a-z]?\s*—/gim),
  ].map((m) => m[1]).sort();
  const verified = dates.length ? dates[dates.length - 1] : null;
  return `- [${f}](${f}) — ${(first ?? "# " + f).replace(/^# /, "")}${verified ? ` _(verified ${verified})_` : " _(no date recorded)_"}`;
};

// ── Build the generated blocks ──────────────────────────────────────────────
const sanity = { "tool groups": activeGroups.length, "tool names": toolNames.size, hooks: hookFiles.length, rules: rules.length, tables: tableCount, "deep docs": sysDocs.length,
  "dashboard pages": dashPages.length, "portal pages": portalPages.length, "api route groups": apiGroups.length, "lib modules": libModules.length };
for (const [k, v] of Object.entries(sanity)) {
  if (!v) {
    console.error(`✖ Refusing to write: ${k} came back 0 — a source file is missing or its format changed.`);
    console.error(`  A confident 0 in the map is worse than a stale number. Fix the extractor, do not commit this.`);
    process.exit(2);
  }
}
// The gate proves the atlas matches the EXTRACTOR, never that the extractor is right.
// Cross-check the rule parser against a second method so a rule written with an ASCII
// hyphen (or indented) cannot silently vanish from both the list and the count.
const allRuleIds = new Set([...claude.matchAll(/^[\s-]*\*\*(R\d+)\*\*/gm)].map((m) => m[1]));
if (allRuleIds.size !== rules.length) {
  const missed = [...allRuleIds].filter((id) => !rules.some((r) => r.id === id));
  console.error(`✖ Rule parser disagreement: strict parse found ${rules.length}, loose scan found ${allRuleIds.size}.`);
  console.error(`  Not parsed: ${missed.join(", ")} — likely an ASCII hyphen instead of an em-dash, or an indented bullet.`);
  process.exit(2);
}

// Truncate on a sentence boundary, never mid-word: the 150-char cut removed the half of
// R104 that says a push to main deploys to PRODUCTION, leaving only the reassuring half.
const summarise = (t) => {
  if (t.length <= 240) return t;
  const cut = t.slice(0, 240);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
  return (stop > 80 ? cut.slice(0, stop + 1) : cut) + " …_(truncated — read the full rule in CLAUDE.md)_";
};

const stamp = new Date().toISOString().slice(0, 10);
const blocks = {
  "mcp-tools": [
    `_Regenerated ${stamp}. Source of truth: uncommented \`register*Tools(server)\` in \`app/api/[transport]/route.ts\` (never a grep across tool files — an unregistered file is not active)._`,
    ``,
    `**${activeGroups.length} active tool groups**, **${toolNames.size} distinct tool names defined** in \`lib/mcp/tools/\` (a definition count, NOT a registration count — an unregistered file would inflate it; the group list below is the authoritative active set).`,
    ``,
    activeGroups.map((g) => `\`${g}\``).join(" · "),
  ].join("\n"),

  hooks: [
    `_Regenerated ${stamp}. Files in \`.claude/hooks/\` (test harnesses excluded); "registered" = referenced by a command in \`.claude/settings.json\`._`,
    ``,
    `**${hookFiles.length} hook scripts**, of which **${hookFiles.filter((f) => registeredHooks.has(f)).length} are registered** in settings.`,
    ``,
    hookFiles.map((f) => `${registeredHooks.has(f) ? "**" + f + "**" : f}`).join(" · "),
    ``,
    `_(bold = registered and firing; plain = present but not wired, e.g. a manual utility)_`,
  ].join("\n"),

  rules: [
    `_Regenerated ${stamp} from the R-rule list in CLAUDE.md — **${rules.length} rules**, highest is ${rules.length ? rules[rules.length - 1].id : "none"}._`,
    ``,
    ...rules.map((r) => `- **${r.id}** — ${summarise(r.text)}`),
  ].join("\n"),

  surface: [
    `_Regenerated ${stamp} by directory scan._`,
    ``,
    `- CRM dashboard pages (${dashPages.length}): ${dashPages.map((d) => `\`${d}\``).join(" ")}`,
    `- Client portal pages (${portalPages.length}): ${portalPages.map((d) => `\`${d}\``).join(" ")}`,
    `- API route groups (${apiGroups.length})`,
    `- Code modules (${libModules.length}): ${libModules.map((d) => `\`${d}\``).join(" ")}`,
    `- Database tables: ${tableCount} _(ground truth: \`lib/database.types.ts\`)_`,
  ].join("\n"),

  "deep-docs": [
    `_Regenerated ${stamp}. Every subsystem doc under \`docs/systems/\` (${sysDocs.length} docs), with the date each was last verified against code — **an old date means treat that doc as a hint and check the code**._`,
    ``,
    ...sysDocs.map(docLine),
  ].join("\n"),
};

// ── Splice into the atlas ───────────────────────────────────────────────────
let atlas = readFileSync(ATLAS, "utf8");
const missing = [];
for (const name of Object.keys(blocks)) {
  const opens = (atlas.match(new RegExp(`<!-- GENERATED:${name} -->`, "g")) || []).length;
  const closes = (atlas.match(new RegExp(`<!-- /GENERATED:${name} -->`, "g")) || []).length;
  if (opens > 1 || closes > 1) {
    console.error(`✖ Marker "${name}" appears ${opens}/${closes} times — must be exactly once.`);
    console.error(`  A duplicated marker silently freezes one copy and the gate stays green.`);
    process.exit(2);
  }
}
for (const [name, body] of Object.entries(blocks)) {
  const re = new RegExp(`(<!-- GENERATED:${name} -->)[\\s\\S]*?(<!-- /GENERATED:${name} -->)`);
  if (!re.test(atlas)) { missing.push(name); continue; }
  atlas = atlas.replace(re, (_m, open, close) => `${open}\n${body}\n${close}`);
}
if (missing.length) {
  console.error(`✖ Atlas is missing generated-section markers: ${missing.join(", ")}`);
  console.error(`  Add <!-- GENERATED:<name> --> … <!-- /GENERATED:<name> --> around each section.`);
  process.exit(1);
}

const current = readFileSync(ATLAS, "utf8");
// Ignore the regeneration date when comparing, so an unchanged system does not go "stale" daily.
const strip = (s) => s.replace(/(_Regenerated )\d{4}-\d{2}-\d{2}/g, "$1<date>");

if (CHECK) {
  // The generator reads the WORKING TREE, but a push ships COMMITS. Two failure modes
  // the council caught, both handled here:
  //
  //  (a) FALSE GREEN — the dangerous one. Regenerate, forget to stage the atlas (R071
  //      forbids `git add -A`, so per-file staging is the norm and this is easy), push.
  //      Working tree matched, so the gate passed while the COMMIT carried the old map.
  //      Caught by comparing the atlas against HEAD, not just against a regeneration.
  //  (b) FALSE RED — an untracked scratch file (a draft doc, a local hook, an
  //      experimental page) changes the counts, so an unrelated push is blocked and the
  //      suggested fix would commit a map describing files that are not in the repo.
  //      A gate that cries wolf gets permanently skipped, so this WARNS instead.
  const sh = (c) => { try { return execSync(c, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString(); } catch { return ""; } };
  const dirtySources = sh("git status --porcelain -- app lib .claude CLAUDE.md docs/systems").trim();

  if (strip(current) !== strip(atlas)) {
    if (dirtySources) {
      console.warn("⚠️  System Atlas looks out of date, but the working tree has uncommitted");
      console.warn("   changes under app/ lib/ .claude/ docs/systems — I cannot tell whether the");
      console.warn("   drift belongs to this push or to your scratch work, so I am NOT blocking.");
      console.warn("   If the drift is real: npm run atlas && commit it.");
      process.exit(0);
    }
    console.error("✖ SYSTEM-ATLAS.md is OUT OF DATE — the code moved and the map did not.");
    console.error("  Fix: npm run atlas   (then commit docs/systems/SYSTEM-ATLAS.md)");
    process.exit(1);
  }

  const atlasUncommitted = sh("git status --porcelain -- docs/systems/SYSTEM-ATLAS.md").trim();
  if (atlasUncommitted) {
    console.error("✖ SYSTEM-ATLAS.md was regenerated but is NOT COMMITTED — the push would ship");
    console.error("  the OLD map while your working copy looks correct. Stage and commit it:");
    console.error("    git add docs/systems/SYSTEM-ATLAS.md");
    process.exit(1);
  }

  console.log("✓ SYSTEM-ATLAS.md matches the live code and is committed.");
  process.exit(0);
}

writeFileSync(ATLAS, atlas);
console.log(
  `✓ Atlas regenerated: ${activeGroups.length} tool groups / ${toolNames.size} tools · ` +
  `${hookFiles.length} hooks (${hookFiles.filter((f) => registeredHooks.has(f)).length} registered) · ` +
  `${rules.length} rules (max ${rules.length ? rules[rules.length - 1].id : "-"}) · ` +
  `${dashPages.length} dashboard + ${portalPages.length} portal pages · ${tableCount} tables · ${sysDocs.length} deep docs`
);
