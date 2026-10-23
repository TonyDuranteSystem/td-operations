/* eslint-disable no-console */
/**
 * Step 1 of a TD Storage app release (dev job 1992a087): sign the finished zip with the update key in THIS Mac's keychain (account td-storage) and write the small
 * package file next to it. Needs no database and no internet. Then, in the CRM, the owner's "Publish new version" panel takes the two files (zip + package).
 *
 *   npx tsx scripts/storage-app-release-package.ts --zip <TDStorage.zip> --version 0.2.0 --build 2 [--notes "text"] [--min-system 13.0]
 *
 * It checks its own work: the signature is verified against the public key the CRM will use before the file is written.
 */
import { execFileSync } from "child_process"
import { readFileSync, statSync, writeFileSync } from "fs"
import { verifyUpdateSignature } from "../lib/storage-app/release-publish"

const SIGN_UPDATE = `${process.env.HOME}/Developer/td-operations-builds/sparkle-2.10.0/bin/sign_update`
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined }

const zip = arg("zip"), version = arg("version"), build = Number(arg("build"))
if (!zip || !version || !/^\d+(\.\d+){0,3}$/.test(version) || !Number.isInteger(build) || build < 1) {
  console.error("Usage: --zip <file> --version <x.y.z> --build <whole number> [--notes text] [--min-system 13.0]"); process.exit(1)
}
const out = execFileSync(SIGN_UPDATE, ["--account", "td-storage", zip], { encoding: "utf8" })
const edSignature = /sparkle:edSignature="([^"]+)"/.exec(out)?.[1]
const length = Number(/length="(\d+)"/.exec(out)?.[1])
if (!edSignature || length !== statSync(zip).size) { console.error(`Signing failed: ${out}`); process.exit(1) }
if (!verifyUpdateSignature(readFileSync(zip), edSignature)) { console.error("The signature does not verify against the CRM's public key — the key in this keychain is not the app's key."); process.exit(1) }
const file = zip.replace(/\.zip$/i, "") + ".release.json"
writeFileSync(file, JSON.stringify({ kind: "td-storage-release", version, build, edSignature, length, notes: arg("notes") ?? "", minSystem: arg("min-system") ?? "13.0" }, null, 2) + "\n")
console.log(`Wrote ${file}\nNow open the CRM → Tools → TD Storage install → Publish, and pick the zip and this file.`)
