/* eslint-disable no-console */
/**
 * Put a new TD Storage app version in the CRM, PAUSED, with no file picking (dev job 1992a087, Antonio 2026-10-27). Signs the finished zip with the update key
 * in this Mac's keychain (account td-storage), reads the upload token from 1Password (it asks for Touch ID), and sends the zip through the CRM's `stage` door.
 * The owner then presses "Offer to Macs" on CRM → Tools → TD Storage install — that button (fresh two-step check) is the only thing that reaches the Macs.
 *
 *   npx tsx scripts/storage-app-release-stage.ts --zip <TDStorage.zip> --version 0.2.4 --build 6 [--notes "text"] [--min-system 13.0] [--site https://crm.tonydurante.us]
 *
 * Token: `op read op://Private/TD Storage release upload/password` (override the item with --token-ref, or set TD_STAGE_TOKEN for a sandbox test).
 */
import { execFileSync } from "child_process"
import { readFileSync, statSync } from "fs"
import { createClient } from "@supabase/supabase-js"
import { verifyUpdateSignature } from "../lib/storage-app/release-publish"
import { RELEASE_BUCKET } from "../lib/storage-app/release"

const SIGN_UPDATE = `${process.env.HOME}/Developer/td-operations-builds/sparkle-2.10.0/bin/sign_update`
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined }

async function post(site: string, token: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${site}/api/storage-app-release/stage`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new Error(`${res.status}: ${typeof data.error === "string" ? data.error : "the CRM refused"}`)
  return data
}

async function main() {
  const zip = arg("zip"), version = arg("version"), build = Number(arg("build")), site = (arg("site") ?? "https://crm.tonydurante.us").replace(/\/$/, "")
  if (!zip || !version || !/^\d+(\.\d+){0,3}$/.test(version) || !Number.isInteger(build) || build < 1) throw new Error("Usage: --zip <file> --version <x.y.z> --build <whole number> [--notes text] [--min-system 13.0] [--site <address>]")
  const bytes = readFileSync(zip)
  const out = execFileSync(SIGN_UPDATE, ["--account", "td-storage", zip], { encoding: "utf8" })
  const edSignature = /sparkle:edSignature="([^"]+)"/.exec(out)?.[1]
  const length = Number(/length="(\d+)"/.exec(out)?.[1])
  if (!edSignature || length !== statSync(zip).size) throw new Error(`Signing failed: ${out}`)
  if (!verifyUpdateSignature(bytes, edSignature)) throw new Error("The signature does not verify against the CRM's public key — the key in this keychain is not the app's key.")

  const token = process.env.TD_STAGE_TOKEN ?? execFileSync("op", ["read", arg("token-ref") ?? "op://Private/TD Storage release upload/password"], { encoding: "utf8" }).trim()
  const prep = await post(site, token, { action: "prepare", version, build, length })
  const { path, token: uploadToken, supabaseUrl, anonKey } = prep as { path: string; token: string; supabaseUrl: string; anonKey: string }
  const up = await createClient(supabaseUrl, anonKey, { auth: { persistSession: false } }).storage.from(RELEASE_BUCKET).uploadToSignedUrl(path, uploadToken, bytes, { contentType: "application/zip" })
  if (up.error) throw new Error(`Upload failed: ${up.error.message}`)
  const done = await post(site, token, { action: "finish", package: { kind: "td-storage-release", version, build, edSignature, length, notes: arg("notes") ?? "", minSystem: arg("min-system") ?? "13.0" } })
  console.log(`Version ${done.version} (build ${done.build}) is in the CRM, PAUSED. Open CRM → Tools → TD Storage install and press "Offer to Macs".`)
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
