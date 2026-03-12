#!/usr/bin/env npx tsx
/**
 * Tool Validation Script
 *
 * Scans all server.tool() registrations in code and compares them
 * against instructions.ts documentation. Reports:
 * - ERROR: tools registered but not documented
 * - WARNING: docs for tools that don't exist
 * - INFO: total counts
 *
 * Usage: npx tsx scripts/validate-tools.ts
 * Add to npm run build as pre-step for CI protection.
 */

import { readFileSync, readdirSync } from "fs"
import { join } from "path"

const TOOLS_DIR = join(__dirname, "../lib/mcp/tools")
const INSTRUCTIONS_FILE = join(__dirname, "../lib/mcp/instructions.ts")

// 1. Extract tool names from code
function getRegisteredTools(): Set<string> {
  const tools = new Set<string>()
  const files = readdirSync(TOOLS_DIR).filter(
    f => f.endsWith(".ts") && !f.includes(" 2")  // skip duplicate files
  )

  for (const file of files) {
    const content = readFileSync(join(TOOLS_DIR, file), "utf-8")
    const lines = content.split("\n")

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("server.tool(")) {
        // Tool name is on this line or the next
        const combined = lines[i] + (lines[i + 1] || "")
        const match = combined.match(/"([^"]+)"/)
        if (match) {
          tools.add(match[1])
        }
      }
    }
  }

  return tools
}

// 2. Extract documented tool names from instructions.ts
function getDocumentedTools(): Set<string> {
  const tools = new Set<string>()
  const content = readFileSync(INSTRUCTIONS_FILE, "utf-8")

  // Match tool names in various formats:
  // - tool_name( — function call style
  // - tool_name — bare name with underscore (snake_case tool names)
  // - **tool_name** — bold markers
  // - `tool_name` — backtick markers
  const patterns = [
    /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s*\(/g,  // tool_name( — function call style
    /\*\*([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\*\*/g,  // **tool_name** — bold
    /`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g,         // `tool_name` — backtick
  ]

  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(content)) !== null) {
      tools.add(match[1])
    }
  }

  // Filter: only keep names that look like actual tool names (match registered prefixes)
  const validPrefixes = [
    "crm_", "qb_", "doc_", "drive_", "gmail_", "email_", "msg_",
    "kb_", "sop_", "sd_", "tax_", "lead_", "offer_", "lease_",
    "cal_", "cb_", "whop_", "formation_", "onboarding_", "banking_",
    "deadline_", "classify_", "docai_", "conv_", "storage_", "sysdoc_",
    "session_", "execute_", "audit_", "task_", "cron_", "job_",
  ]
  const filtered = new Set<string>()
  Array.from(tools).forEach(t => {
    if (validPrefixes.some(p => t.startsWith(p))) filtered.add(t)
  })

  return filtered
}

// 3. Run validation
const registered = getRegisteredTools()
const documented = getDocumentedTools()

const undocumented = Array.from(registered).filter(t => !documented.has(t)).sort()
const orphanDocs = Array.from(documented).filter(t => !registered.has(t)).sort()

let hasError = false

console.log(`\n📊 Tool Validation Report`)
console.log(`========================`)
console.log(`Registered in code: ${registered.size}`)
console.log(`Documented in instructions.ts: ${documented.size}`)
console.log()

if (undocumented.length > 0) {
  hasError = true
  console.log(`❌ ERROR: ${undocumented.length} tools NOT documented in instructions.ts:`)
  for (const t of undocumented) {
    console.log(`   - ${t}`)
  }
  console.log()
}

if (orphanDocs.length > 0) {
  console.log(`⚠️  WARNING: ${orphanDocs.length} documented tools NOT found in code:`)
  for (const t of orphanDocs) {
    console.log(`   - ${t}`)
  }
  console.log()
}

if (undocumented.length === 0 && orphanDocs.length === 0) {
  console.log(`✅ All tools are properly documented!`)
}

// Exit with error code if undocumented tools found
if (hasError) {
  console.log(`\nFix: Add documentation for undocumented tools in lib/mcp/instructions.ts`)
  process.exit(1)
}
