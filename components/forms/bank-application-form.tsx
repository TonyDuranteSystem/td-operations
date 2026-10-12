"use client"

/**
 * The bank-account application form (dev job 11d484a4) — ONE component for both uses:
 *  - the public one-time link page (app/bank-application/[token]) — `preview` false;
 *  - the staff "View form" screen (app/(dashboard)/forms/bank-application/preview) — `preview` true:
 *    the exact same screens, but it never calls the server and never submits.
 * The link works for ONE browser (the first to press Start) and dies on submit — see lib/bofa-intake/lock.ts.
 * Fields and the required/optional rules come from lib/bofa-intake/schema.ts, the same file the
 * server validates against.
 */

import { useEffect, useRef, useState } from "react"
import { BOFA_DOC_SLOTS, BOFA_MAX_FILE_BYTES, BOFA_MONTHLY_DEPOSITS, effectiveMime, isAllowedMime, validateSubmission } from "@/lib/bofa-intake/schema"

type PageState = "loading" | "start" | "form" | "used" | "missing" | "error" | "done"

const inputCls = "w-full h-9 rounded-md border border-gray-300 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
const areaCls = "w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
const cardCls = "bg-white border border-gray-200 rounded-xl p-5 mb-3"

function Field({ label, hint, optional, children }: { label: string; hint?: string; optional?: boolean; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <label className="block text-sm font-medium">
        {label}
        <span className={`ml-2 text-[11px] ${optional ? "text-gray-400" : "text-red-600"}`}>{optional ? "Optional" : "Required"}</span>
      </label>
      {hint && <p className="text-xs text-gray-500 mt-0.5 mb-1.5">{hint}</p>}
      <div className={hint ? "" : "mt-1.5"}>{children}</div>
    </div>
  )
}

export function BankApplicationForm({ token, preview = false }: { token: string; preview?: boolean }) {
  const [state, setState] = useState<PageState>(preview ? "form" : "loading")
  const [data, setData] = useState<Record<string, string>>({})
  const [files, setFiles] = useState<Record<string, File | null>>({})
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const topRef = useRef<HTMLDivElement>(null)
  const finished = useRef<Record<string, { sig: string; path: string }>>({})

  // Loading the page only READS the link's state; it never claims it. The claim happens when the
  // visitor presses "Start application", so a link-preview bot or an in-app browser that merely loads
  // the page cannot burn the link. A ref keeps React's dev double-run of effects to one request.
  const loaded = useRef(false)
  const toState = (d: { state?: string }): PageState =>
    d.state === "form" ? "form" : d.state === "start" ? "start" : d.state === "missing" ? "missing" : d.state === "error" ? "error" : "used"
  useEffect(() => {
    if (preview || loaded.current) return
    loaded.current = true
    fetch(`/api/bank-application/${token}`, { cache: "no-store" })
      .then(async (r) => setState(toState(await r.json().catch(() => ({})))))
      .catch(() => setState("error"))
  }, [token, preview])

  async function start() {
    setBusy(true)
    try {
      const r = await fetch(`/api/bank-application/${token}`, { method: "POST" })
      setState(toState(await r.json().catch(() => ({}))))
    } catch {
      setState("error")
    } finally {
      setBusy(false)
    }
  }

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setData((d) => ({ ...d, [k]: e.target.value }))
  const text = (k: string, ph?: string, type = "text") => (
    <input className={inputCls} type={type} value={data[k] ?? ""} onChange={set(k)} placeholder={ph} />
  )

  const pickFile = (key: string, file: File | null, input?: HTMLInputElement) => {
    const reject = (message: string) => {
      // Clear BOTH the box and the stored file so what the page shows is what would be submitted.
      if (input) input.value = ""
      setFiles((f) => ({ ...f, [key]: null }))
      setError(message)
    }
    if (file && file.size > BOFA_MAX_FILE_BYTES) {
      return reject(`"${file.name}" is ${(file.size / 1048576).toFixed(1)} MB. The limit is 10 MB per document.`)
    }
    if (file && !isAllowedMime(effectiveMime(file.name, file.type))) {
      return reject("Upload a PDF or a photo (JPG, PNG, HEIC or WebP).")
    }
    setError("")
    setFiles((f) => ({ ...f, [key]: file }))
  }

  async function submit() {
    setError("")
    if (preview) {
      setError("This is a preview. Nothing is submitted or saved.")
      return
    }
    const early = validateSubmission(data, BOFA_DOC_SLOTS.filter((s) => files[s.key]).map((s) => ({ key: s.key, name: files[s.key]!.name, path: `${token}/${s.key}/pending` })), token)
    if ("error" in early) {
      topRef.current?.scrollIntoView({ behavior: "smooth" })
      return setError(early.error)
    }
    if (!consent) return setError("Please confirm the statement at the bottom before submitting.")
    setBusy(true)
    try {
      const uploaded: { key: string; name: string; path: string }[] = []
      for (const s of BOFA_DOC_SLOTS) {
        const file = files[s.key]
        if (!file) continue
        const sig = `${file.name}|${file.size}|${file.lastModified}`
        const done = finished.current[s.key]
        if (done && done.sig === sig) {
          // A previous attempt already uploaded this exact file: reuse it instead of storing a second copy.
          uploaded.push({ key: s.key, name: file.name, path: done.path })
          continue
        }
        const mime = effectiveMime(file.name, file.type)
        const urlRes = await fetch(`/api/bank-application/${token}/upload-url`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slot: s.key, file_name: file.name, file_size: file.size, mime }),
        })
        if (!urlRes.ok) {
          const d = await urlRes.json().catch(() => ({}))
          throw new Error(d.error || "Could not start the upload. Please try again.")
        }
        const { signedUrl, path } = await urlRes.json()
        const put = await fetch(signedUrl, { method: "PUT", headers: { "Content-Type": mime }, body: file })
        if (!put.ok) throw new Error(`"${file.name}" did not upload. Check your connection and try again.`)
        finished.current[s.key] = { sig, path }
        uploaded.push({ key: s.key, name: file.name, path })
      }
      const res = await fetch(`/api/bank-application/${token}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data, files: uploaded }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || "Could not save your application. Please try again.")
      }
      setState("done")
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Something went wrong. Please try again.")
      topRef.current?.scrollIntoView({ behavior: "smooth" })
    } finally {
      setBusy(false)
    }
  }

  const shell = (children: React.ReactNode) => (
    <div className={preview ? "bg-gray-50 py-4 px-4 rounded-lg" : "min-h-screen bg-gray-50 py-8 px-4"}>
      <div className="max-w-xl mx-auto">
        {preview && (
          <div className="rounded-lg bg-blue-50 text-blue-900 text-sm p-3 mb-3">
            Preview for staff: this is exactly what the client sees. Nothing you type here is saved or sent, and no link is used.
          </div>
        )}
        {children}
      </div>
    </div>
  )

  if (state === "loading") return shell(<p className="text-center text-sm text-gray-500 pt-20">Loading…</p>)
  if (state === "error") {
    return shell(
      <div className={`${cardCls} text-center py-10 mt-16`}>
        <h1 className="text-lg font-medium mb-2">Something went wrong</h1>
        <p className="text-sm text-gray-500">We couldn&apos;t load this page. Wait a moment and reload it. Your link has not been used.</p>
      </div>,
    )
  }
  if (state === "start") {
    return shell(
      <div className={`${cardCls} mt-16`}>
        <p className="text-xs text-gray-500 mb-1">Tony Durante LLC</p>
        <h1 className="text-xl font-medium mb-2">Business bank account application</h1>
        <p className="text-sm text-gray-500 mb-3">
          This link can be used once, on the device and browser you start it from. Have your passport, proof of address, company documents, ITIN letter and lease ready. It takes about 10 minutes.
        </p>
        <p className="text-sm text-gray-500 mb-4">If you are only forwarding this link to someone else, do not press Start.</p>
        <button
          type="button"
          onClick={start}
          disabled={busy}
          className="w-full h-10 rounded-md bg-gray-900 text-white text-sm font-medium disabled:opacity-60"
        >
          {busy ? "Starting…" : "Start application"}
        </button>
      </div>,
    )
  }
  if (state === "missing" || state === "used") {
    return shell(
      <div className={`${cardCls} text-center py-10 mt-16`}>
        <h1 className="text-lg font-medium mb-2">{state === "missing" ? "This link isn't valid" : "This link has already been used"}</h1>
        <p className="text-sm text-gray-500">
          {state === "missing" ? "Check the link you were sent, or ask Tony Durante LLC for a new one." : "For security, each link works once. Ask Tony Durante LLC for a new one."}
        </p>
      </div>,
    )
  }
  if (state === "done") {
    return shell(
      <div className={`${cardCls} text-center py-10 mt-16`}>
        <h1 className="text-lg font-medium mb-2">Application received</h1>
        <p className="text-sm text-gray-500">Thank you. We have your details and documents and will be in touch about the next steps. You can close this page.</p>
      </div>,
    )
  }

  return shell(
    <>
      <div ref={topRef} />
      <div className={cardCls}>
        <p className="text-xs text-gray-500 mb-1">Tony Durante LLC</p>
        <h1 className="text-xl font-medium mb-1">Business bank account application</h1>
        <p className="text-sm text-gray-500">
          Fill in your details and upload your documents. It takes about 10 minutes. You can only use this link once, so have your documents ready before you start.
        </p>
      </div>
      <div className="rounded-lg bg-amber-50 text-amber-900 text-sm p-3 mb-3">
        Who receives your information: your details and documents are shared only with the bank&apos;s account-opening team and Tony Durante LLC, and used only for this application.
      </div>

      {error && <div className="rounded-lg bg-red-50 text-red-700 text-sm p-3 mb-3" role="alert">{error}</div>}

      <div className={cardCls}>
        <h2 className="text-base font-medium">1. About you</h2>
        <p className="text-sm text-gray-500 mb-4">The person who will own and manage the account.</p>
        <Field label="Full legal name" hint="Exactly as shown on your passport.">{text("full_name", "Jordan Alexander Smith")}</Field>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Email">{text("email", "name@example.com", "email")}</Field>
          <Field label="Phone">{text("phone", "+44 20 7946 0000")}</Field>
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Citizenship">{text("citizenship", "Canadian")}</Field>
          <Field label="ITIN">{text("itin", "9XX-XX-XXXX")}</Field>
        </div>
        <p className="text-sm font-medium text-gray-600 mt-5">Home address</p>
        <Field label="Street">{text("home_street", "221 Maple Avenue, Apt 5")}</Field>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="City">{text("home_city", "Toronto")}</Field>
          <Field label="Region / province">{text("home_region", "Ontario")}</Field>
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Zip code">{text("home_zip", "M5V 2T6")}</Field>
          <Field label="Country">{text("home_country", "Canada")}</Field>
        </div>
      </div>

      <div className={cardCls}>
        <h2 className="text-base font-medium">2. Your company</h2>
        <p className="text-sm text-gray-500 mb-4">The US company that will own the account.</p>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Company name">{text("company_name", "Northwind Trading LLC")}</Field>
          <Field label="EIN">{text("ein", "00-0000000")}</Field>
        </div>
        <Field label="State of formation">{text("state_of_formation", "Delaware")}</Field>
        <p className="text-sm font-medium text-gray-600 mt-5">Company address (as on the lease)</p>
        <Field label="Street">{text("company_street", "1450 Harbor View Drive, Suite 210")}</Field>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="City">{text("company_city", "Austin")}</Field>
          <Field label="State / region">{text("company_region", "Texas")}</Field>
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Zip code">{text("company_zip", "78701")}</Field>
          <Field label="Country">{text("company_country", "United States")}</Field>
        </div>
        <Field label="Website or social page" optional>{text("website", "https://")}</Field>
      </div>

      <div className={cardCls}>
        <h2 className="text-base font-medium">3. What your business does</h2>
        <p className="text-sm text-gray-500 mb-4">The bank reviews this closely. Be specific and plain. Two or three sentences per answer is enough.</p>
        <Field label="Describe your business" hint={'What do you sell or do, in plain words? Example: "We sell handmade leather bags online to customers in Europe."'}>
          <textarea className={areaCls} rows={4} value={data.business_description ?? ""} onChange={set("business_description")} />
        </Field>
        <Field label="Who are your customers?" hint="Type of customer (individuals or companies) and the countries they are in.">
          <textarea className={areaCls} rows={3} value={data.customers ?? ""} onChange={set("customers")} />
        </Field>
        <Field label="How does the company make money?" hint="Where the payments come from (online store, invoices, platform payouts) and in what currency.">
          <textarea className={areaCls} rows={3} value={data.revenue_model ?? ""} onChange={set("revenue_model")} />
        </Field>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Expected monthly deposits">
            <select className={inputCls} value={data.monthly_deposits ?? ""} onChange={set("monthly_deposits")}>
              <option value="">Select a range</option>
              {BOFA_MONTHLY_DEPOSITS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </Field>
          <Field label="Source of the first deposit">{text("first_deposit_source", "Owner's savings, sales revenue")}</Field>
        </div>
      </div>

      <div className={cardCls}>
        <h2 className="text-base font-medium">4. Documents</h2>
        <p className="text-sm text-gray-500 mb-4">One document per box. PDF or photo, up to 10 MB each, all four corners visible and the text readable.</p>
        {BOFA_DOC_SLOTS.map((s, i) => (
          <Field key={s.key} label={`${i + 1}. ${s.label}`} hint={s.hint} optional={!s.required}>
            <input
              type="file"
              accept="application/pdf,image/jpeg,image/png,image/heic,image/heif,image/webp"
              className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-gray-300 file:bg-white file:px-3 file:py-1.5 file:text-sm"
              onChange={(e) => pickFile(s.key, e.target.files?.[0] ?? null, e.target)}
            />
            {files[s.key] && <p className="text-xs text-gray-500 mt-1">{files[s.key]!.name}</p>}
          </Field>
        ))}
      </div>

      <div className={cardCls}>
        <label className="flex gap-3 items-start text-sm cursor-pointer">
          <input type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>
            I confirm the information and documents are true, complete and my own. I agree they can be shared with the bank&apos;s account-opening team and Tony Durante LLC for this application. I understand this does not guarantee approval.
          </span>
        </label>
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="mt-4 w-full h-10 rounded-md bg-gray-900 text-white text-sm font-medium disabled:opacity-60"
        >
          {busy ? "Uploading your documents…" : "Submit application"}
        </button>
        <p className="text-xs text-gray-500 text-center mt-2">This link stops working once you submit.</p>
      </div>
    </>,
  )
}
