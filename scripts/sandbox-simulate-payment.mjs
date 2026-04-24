#!/usr/bin/env node
/**
 * Sandbox Payment Simulator — CLI
 *
 * Simulates the full payment activation chain for a signed offer
 * in the sandbox environment. Loads credentials from .env.sandbox.
 *
 * Usage:
 *   node scripts/sandbox-simulate-payment.mjs \
 *     --offer-token <token> \
 *     --contract-type <formation|onboarding> \
 *     [--base-url <sandbox-base-url>]
 *
 * Default base URL: https://td-operations-sandbox.vercel.app
 */

import { readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))

function loadEnvFile(envPath) {
  let raw
  try {
    raw = readFileSync(envPath, "utf8")
  } catch {
    console.error("❌ File not found:", envPath)
    process.exit(1)
  }
  const parsed = {}
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const m = trimmed.match(/^([A-Z0-9_]+)=("?)(.*)\2$/)
    if (m) parsed[m[1]] = m[3]
  }
  return parsed
}

function parseArgs(args) {
  const result = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--offer-token") result.offerToken = args[++i]
    else if (args[i] === "--contract-type") result.contractType = args[++i]
    else if (args[i] === "--base-url") result.baseUrl = args[++i]
  }
  return result
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (!args.offerToken || !args.contractType) {
    console.error(
      "Usage: node sandbox-simulate-payment.mjs --offer-token <token> --contract-type <formation|onboarding>",
    )
    process.exit(1)
  }

  if (!["formation", "onboarding"].includes(args.contractType)) {
    console.error("❌ --contract-type must be 'formation' or 'onboarding'")
    process.exit(1)
  }

  const envPath = resolve(__dirname, "../.env.sandbox")
  const env = loadEnvFile(envPath)
  const apiSecret = env.API_SECRET_TOKEN

  if (!apiSecret) {
    console.error("❌ API_SECRET_TOKEN not found in .env.sandbox")
    process.exit(1)
  }

  const baseUrl = args.baseUrl || "https://td-operations-sandbox.vercel.app"

  console.log("🚀 Simulating payment...")
  console.log("   Offer token:  ", args.offerToken)
  console.log("   Contract type:", args.contractType)
  console.log("   Sandbox URL:  ", baseUrl)
  console.log("")

  let res
  try {
    res = await fetch(`${baseUrl}/api/sandbox/simulate-payment`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiSecret}`,
      },
      body: JSON.stringify({
        offer_token: args.offerToken,
        contract_type: args.contractType,
      }),
    })
  } catch (err) {
    console.error("❌ Network error:", err.message)
    process.exit(1)
  }

  let data
  try {
    data = await res.json()
  } catch {
    console.error("❌ Non-JSON response (status", res.status, res.statusText + ")")
    process.exit(1)
  }

  if (!res.ok) {
    console.error("❌ Error (HTTP", res.status + "):", data.error || res.statusText)
    process.exit(1)
  }

  const ok = data.success ? "✅" : "⚠️"
  console.log(ok, "Result")
  console.log("")
  console.log("  Activation ID:  ", data.activation_id || "N/A")
  console.log("  Status:         ", data.activation_status || "N/A")
  console.log("  Contact ID:     ", data.contact_id || "N/A")
  console.log("  Account ID:     ", data.account_id || "N/A")
  console.log("  Portal Tier:    ", data.portal_tier || "N/A")
  console.log("  SDs Created:    ", data.sd_created ?? 0)
  console.log("")
  console.log("── Activate-Service Response ──────────────────")
  console.log(JSON.stringify(data.activate_service_response, null, 2))
}

main().catch((err) => {
  console.error("❌ Fatal:", err.message || err)
  process.exit(1)
})
