/* eslint-disable no-console */
/**
 * Publish a new version of the TD Storage Mac app (dev job 1992a087). Signs the zip with the update key in this Mac's keychain (account
 * td-storage), uploads it to the private app-releases bucket and writes the release record the update feed reads (lib/storage-app/release.ts).
 *
 *   npx tsx scripts/storage-app-release.ts --zip <TDStorage.zip> --version 0.2.0 --build 2 [--notes "text"] [--rollout 100] [--min-system 13.0] [--paused] [--republish]
 *
 * Targets the database named by .env.local — the SANDBOX. For production, only on Antonio's word: pass --env-file <file with the production
 * values> --production (without --production a production database is refused, and with it a sandbox one is).
 * --republish replaces the zip of the SAME build number (a bad upload); a lower number is never allowed.
 * The version number must be higher than the one published before (Sparkle compares the build number: it only ever moves forward).
 */
import { config } from "dotenv"
import { execFileSync } from "child_process"
import { readFileSync, statSync } from "fs"
import { createClient } from "@supabase/supabase-js"
import { RELEASE_BUCKET, RELEASE_KEY, parseRelease } from "../lib/storage-app/release"

const SANDBOX_REF = "xjcxlmlpeywtwkhstjlw"
const PRODUCTION_REF = "ydzipybqeebtpcvsbtvs"
const SIGN_UPDATE = `${process.env.HOME}/Developer/td-operations-builds/sparkle-2.10.0/bin/sign_update`

function arg(name: string): string | undefined { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined }
const flag = (name: string) => process.argv.includes(`--${name}`)

async function main() {
  config({ path: arg("env-file") ?? ".env.local" })
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""
  const production = flag("production")
  if (!url || !key) throw new Error("The environment file has no Supabase address / service key.")
  if (production && !url.includes(PRODUCTION_REF)) throw new Error("REFUSED: --production but the database is not the production one.")
  if (!production && !url.includes(SANDBOX_REF)) throw new Error("REFUSED: this database is not the sandbox. Production needs --production (and Antonio's word).")

  const zip = arg("zip"), version = arg("version"), build = Number(arg("build"))
  if (!zip || !version || !Number.isInteger(build) || build < 1) throw new Error("Usage: --zip <file> --version <x.y.z> --build <whole number>")
  const size = statSync(zip).size

  // sign: sign_update prints  sparkle:edSignature="…" length="…"
  const out = execFileSync(SIGN_UPDATE, ["--account", "td-storage", zip], { encoding: "utf8" })
  const edSignature = /sparkle:edSignature="([^"]+)"/.exec(out)?.[1]
  const length = Number(/length="(\d+)"/.exec(out)?.[1])
  if (!edSignature || length !== size) throw new Error(`Signing failed or the length differs (${length} vs ${size}): ${out}`)

  const db = createClient(url, key, { auth: { persistSession: false } })
  const { data: prev } = await db.from("app_settings").select("value").eq("key", RELEASE_KEY).maybeSingle()
  const before = parseRelease(prev?.value)
  if (before && (flag("republish") ? build < before.build : build <= before.build)) throw new Error(`The build number must go up: ${before.version} is build ${before.build}, this is ${build}.`)

  const { data: buckets } = await db.storage.listBuckets()
  if (!buckets?.some((b) => b.name === RELEASE_BUCKET)) {
    const { error } = await db.storage.createBucket(RELEASE_BUCKET, { public: false })
    if (error) throw new Error(`Could not create the bucket: ${error.message}`)
  }
  const path = `storage-app/${version}/TDStorage-${version}.zip`
  const up = await db.storage.from(RELEASE_BUCKET).upload(path, readFileSync(zip), { contentType: "application/zip", upsert: true })
  if (up.error) throw new Error(`Upload failed: ${up.error.message}`)

  const value = {
    version, build, edSignature, length, path,
    notes: arg("notes") ?? "", minSystem: arg("min-system") ?? "13.0",
    enabled: !flag("paused"), rolloutPercent: Number(arg("rollout") ?? 100), publishedAt: new Date().toISOString(),
  }
  if (!parseRelease(value)) throw new Error("The release record is not valid — nothing written.")
  const { error } = await db.from("app_settings").upsert({ key: RELEASE_KEY, value, updated_at: new Date().toISOString() })
  if (error) throw new Error(`Could not write the release record: ${error.message}`)
  console.log(`Published ${version} (build ${build}, ${size} bytes) to ${production ? "PRODUCTION" : "the sandbox"}${flag("paused") ? " — PAUSED (not offered yet)" : ""}.`)
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
