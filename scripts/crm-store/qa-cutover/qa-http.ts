/* eslint-disable no-console -- a QA helper */
/**
 * HTTP helper for the Phase 3 sandbox QA (dev job ad09ea91): signs a throw-away SANDBOX user in (supabase-js, anon key)
 * and talks to the local dev server with the same session cookie the browser would carry (@supabase/ssr 0.5 format:
 * "base64-" + base64url(session JSON), chunked at 3180 characters).
 */
import { config } from "dotenv"
import { readFileSync } from "fs"
import { createClient } from "@supabase/supabase-js"
config({ path: ".env.local" })

const CREDS_FILE = "/private/tmp/claude-501/scratch/qa-creds.json"
export const BASE = process.env.QA_BASE ?? "http://localhost:3100"

export type QaUser = "staff" | "clientUx" | "clientTc"

export async function sessionCookie(who: QaUser): Promise<string> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL as string
  if (url.includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  const creds = JSON.parse(readFileSync(CREDS_FILE, "utf8"))[who] as { email: string; password: string }
  const sb = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string, { auth: { persistSession: false } })
  const { data, error } = await sb.auth.signInWithPassword(creds)
  if (error || !data.session) throw new Error(`QA login failed for ${who}: ${error?.message}`)
  const ref = new URL(url).hostname.split(".")[0]
  const name = `sb-${ref}-auth-token`
  const value = "base64-" + Buffer.from(JSON.stringify(data.session)).toString("base64url")
  const CHUNK = 3180
  if (value.length <= CHUNK) return `${name}=${value}`
  const parts: string[] = []
  for (let i = 0, n = 0; i < value.length; i += CHUNK, n++) parts.push(`${name}.${n}=${value.slice(i, i + CHUNK)}`)
  return parts.join("; ")
}

export interface CallOpts { method?: string; cookie?: string; json?: unknown; form?: FormData; headers?: Record<string, string> }
export interface CallResult { status: number; ok: boolean; headers: Headers; text: string; json: unknown; bytes: Buffer }

export async function call(path: string, o: CallOpts = {}): Promise<CallResult> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) }
  if (o.cookie) headers.cookie = o.cookie
  let body: BodyInit | undefined
  if (o.json !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(o.json) }
  if (o.form) body = o.form
  const res = await fetch(`${BASE}${path}`, { method: o.method ?? (body ? "POST" : "GET"), headers, body, redirect: "manual" })
  const bytes = Buffer.from(await res.arrayBuffer())
  const text = bytes.toString("utf8")
  let json: unknown = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, ok: res.ok, headers: res.headers, text, json, bytes }
}

export function pdf(label: string): Buffer {
  return Buffer.from(`%PDF-1.4\n% QA Test ${label} ${Date.now()}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF`)
}

/** A real, parseable one-page PDF (pdf-lib) for flows that merge or read the file. */
export async function realPdf(label: string): Promise<Buffer> {
  const { PDFDocument } = await import("pdf-lib")
  const doc = await PDFDocument.create()
  doc.addPage([612, 792]).drawText(`QA Test ${label} ${Date.now()}`, { x: 50, y: 700, size: 14 })
  return Buffer.from(await doc.save())
}

export function form(fields: Record<string, string>, file?: { name: string; data: Buffer; type: string }): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.append(k, v)
  if (file) f.append("file", new Blob([new Uint8Array(file.data)], { type: file.type }), file.name)
  return f
}

let pass = 0
let fail = 0
export const results: Array<{ id: string; ok: boolean; note: string }> = []
export function check(id: string, ok: boolean, note = "") {
  results.push({ id, ok, note })
  if (ok) pass++; else fail++
  console.log(`${ok ? "PASS" : "FAIL"}  ${id} — ${note}`)
}
export function summary() { console.log(`\n${pass} passed, ${fail} failed`) }
