"use client"

/**
 * SchemaForm — schema-driven controlled form renderer.
 *
 * Takes a FieldSpec (from `lib/forms/schema-introspection.introspect()`),
 * a current value, and an onChange callback. Renders the matching form
 * fields, recursively for nested objects.
 *
 * Used by the workflow editor for both top-level workflow fields and the
 * per-action handler_params block. Adding support for a new handler with a
 * new param shape = define its Zod schema; the form renders automatically.
 *
 * Out of scope for v1: drag-and-drop, rich field validation (Zod runs on
 * save), nested-object collapse/expand chrome (renders flat with indent).
 *
 * Path tracking: each field receives `path` (array of keys from root) so
 * external Zod validation errors can be mapped back to the right field.
 * Error display takes `errors: Record<path-as-dot-string, string[]>` —
 * caller is responsible for converting Zod issues to this shape.
 */

import { useState } from "react"
import type { FieldSpec } from "@/lib/forms/schema-introspection"

export interface SchemaFormErrors {
  /** Map of dot-joined path → array of error messages for that field. */
  [path: string]: string[] | undefined
}

interface SchemaFormProps {
  spec: FieldSpec
  value: unknown
  onChange: (next: unknown) => void
  errors?: SchemaFormErrors
  path?: ReadonlyArray<string>
  /** When true, the top-level container has no border/padding (used inside
   *  another already-bordered card). */
  bare?: boolean
}

function pathKey(path: ReadonlyArray<string>): string {
  return path.join(".")
}

function FieldLabel({ spec, htmlFor }: { spec: FieldSpec; htmlFor: string }) {
  return (
    <label htmlFor={htmlFor} className="block text-xs font-medium text-zinc-800 mb-1">
      {spec.label}
      {spec.required && <span className="ml-0.5 text-red-600" aria-label="required">*</span>}
    </label>
  )
}

function FieldHelp({ spec }: { spec: FieldSpec }) {
  if (!spec.description) return null
  return <p className="mt-1 text-[11px] text-zinc-500">{spec.description}</p>
}

function FieldErrors({ messages }: { messages: string[] | undefined }) {
  if (!messages || messages.length === 0) return null
  return (
    <ul className="mt-1 text-[11px] text-red-600 list-disc list-inside">
      {messages.map((m, i) => (
        <li key={i}>{m}</li>
      ))}
    </ul>
  )
}

function inputClassName(hasError: boolean): string {
  return `w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
    hasError ? "border-red-400 bg-red-50" : "border-zinc-300"
  }`
}

export function SchemaForm({
  spec,
  value,
  onChange,
  errors,
  path = [],
  bare = false,
}: SchemaFormProps) {
  const key = pathKey(path)
  const id = `schemaform-${key || "root"}`
  const fieldErrors = errors?.[key]

  switch (spec.kind) {
    case "string": {
      const strVal = typeof value === "string" ? value : ""
      const isLong = (spec.maxLength ?? 0) > 200
      return (
        <div className={bare ? "" : "mb-3"}>
          <FieldLabel spec={spec} htmlFor={id} />
          {isLong ? (
            <textarea
              id={id}
              value={strVal}
              onChange={(e) => onChange(e.target.value)}
              rows={3}
              className={inputClassName(!!fieldErrors)}
            />
          ) : (
            <input
              id={id}
              type="text"
              value={strVal}
              onChange={(e) => onChange(e.target.value)}
              className={inputClassName(!!fieldErrors)}
            />
          )}
          <FieldHelp spec={spec} />
          <FieldErrors messages={fieldErrors} />
        </div>
      )
    }

    case "number": {
      const numVal =
        typeof value === "number" ? String(value) : typeof value === "string" ? value : ""
      return (
        <div className={bare ? "" : "mb-3"}>
          <FieldLabel spec={spec} htmlFor={id} />
          <input
            id={id}
            type="number"
            value={numVal}
            step={spec.integer ? 1 : "any"}
            onChange={(e) => {
              const s = e.target.value
              if (s === "") return onChange(undefined)
              const parsed = spec.integer ? parseInt(s, 10) : parseFloat(s)
              onChange(Number.isNaN(parsed) ? undefined : parsed)
            }}
            className={inputClassName(!!fieldErrors)}
          />
          <FieldHelp spec={spec} />
          <FieldErrors messages={fieldErrors} />
        </div>
      )
    }

    case "boolean": {
      const bVal = value === true
      return (
        <div className={bare ? "" : "mb-3"}>
          <label className="inline-flex items-center gap-2 text-xs font-medium text-zinc-800">
            <input
              id={id}
              type="checkbox"
              checked={bVal}
              onChange={(e) => onChange(e.target.checked)}
              className="rounded border-zinc-300"
            />
            {spec.label}
            {spec.required && <span className="ml-0.5 text-red-600">*</span>}
          </label>
          <FieldHelp spec={spec} />
          <FieldErrors messages={fieldErrors} />
        </div>
      )
    }

    case "enum": {
      const eVal = typeof value === "string" ? value : ""
      return (
        <div className={bare ? "" : "mb-3"}>
          <FieldLabel spec={spec} htmlFor={id} />
          <select
            id={id}
            value={eVal}
            onChange={(e) => onChange(e.target.value || undefined)}
            className={inputClassName(!!fieldErrors)}
          >
            <option value="">{spec.required ? "— Choose —" : "— None —"}</option>
            {spec.options.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
          <FieldHelp spec={spec} />
          <FieldErrors messages={fieldErrors} />
        </div>
      )
    }

    case "literal":
      return (
        <div className={bare ? "" : "mb-3"}>
          <FieldLabel spec={spec} htmlFor={id} />
          <input
            id={id}
            type="text"
            value={String(spec.value ?? "")}
            readOnly
            className={`${inputClassName(false)} bg-zinc-50 text-zinc-600`}
          />
          <FieldHelp spec={spec} />
        </div>
      )

    case "array_of_strings":
      return (
        <ArrayOfStringsField
          spec={spec}
          value={value}
          onChange={onChange}
          fieldErrors={fieldErrors}
          bare={bare}
        />
      )

    case "scalar_union":
      return (
        <ScalarUnionField
          spec={spec}
          value={value}
          onChange={onChange}
          fieldErrors={fieldErrors}
          bare={bare}
        />
      )

    case "record":
      return (
        <JsonField
          spec={spec}
          value={value}
          onChange={onChange}
          fieldErrors={fieldErrors}
          bare={bare}
        />
      )

    case "object": {
      const objVal = (value && typeof value === "object" ? value : {}) as Record<string, unknown>
      const isRoot = path.length === 0
      const containerCls = isRoot || bare ? "" : "ml-3 pl-3 border-l-2 border-zinc-100"
      return (
        <div className={containerCls}>
          {!isRoot && !bare && <FieldLabel spec={spec} htmlFor={id} />}
          {Object.entries(spec.fields).map(([k, childSpec]) => (
            <SchemaForm
              key={k}
              spec={childSpec}
              value={objVal[k]}
              onChange={(childNext) => {
                const next = { ...objVal }
                if (childNext === undefined) {
                  delete next[k]
                } else {
                  next[k] = childNext
                }
                onChange(next)
              }}
              errors={errors}
              path={[...path, k]}
            />
          ))}
          {!isRoot && <FieldHelp spec={spec} />}
          {!isRoot && <FieldErrors messages={fieldErrors} />}
        </div>
      )
    }

    case "unsupported":
      return (
        <JsonField
          spec={spec}
          value={value}
          onChange={onChange}
          fieldErrors={fieldErrors}
          bare={bare}
        />
      )
  }
}

// ─── Subcomponents ─────────────────────────────────────────────────────

interface SubFieldProps {
  spec: FieldSpec
  value: unknown
  onChange: (next: unknown) => void
  fieldErrors: string[] | undefined
  bare: boolean
}

function ArrayOfStringsField({ spec, value, onChange, fieldErrors, bare }: SubFieldProps) {
  const arr = Array.isArray(value) ? (value as string[]) : []
  return (
    <div className={bare ? "" : "mb-3"}>
      <FieldLabel spec={spec} htmlFor={`arr-${spec.label}`} />
      <div className="space-y-1">
        {arr.map((item, i) => (
          <div key={i} className="flex gap-2">
            <input
              type="text"
              value={item}
              onChange={(e) => {
                const next = [...arr]
                next[i] = e.target.value
                onChange(next)
              }}
              className={inputClassName(false)}
            />
            <button
              type="button"
              onClick={() => onChange(arr.filter((_, j) => j !== i))}
              className="px-2 text-xs text-red-600 border border-red-200 rounded hover:bg-red-50"
              aria-label="Remove"
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onChange([...arr, ""])}
        className="mt-1 px-2 py-1 text-xs border border-zinc-300 rounded hover:bg-zinc-50"
      >
        + Add
      </button>
      <FieldHelp spec={spec} />
      <FieldErrors messages={fieldErrors} />
    </div>
  )
}

function ScalarUnionField({ spec, value, onChange, fieldErrors, bare }: SubFieldProps) {
  // Detect the current type from the value (computed unconditionally so the
  // useState below stays at the top of the component per react-hooks rules).
  const detectedType: "string" | "number" | "boolean" | "null" =
    value === null
      ? "null"
      : typeof value === "number"
        ? "number"
        : typeof value === "boolean"
          ? "boolean"
          : "string"

  const [pickedType, setPickedType] = useState(detectedType)
  if (spec.kind !== "scalar_union") return null
  const usableType = spec.allowed.includes(pickedType) ? pickedType : spec.allowed[0]

  return (
    <div className={bare ? "" : "mb-3"}>
      <FieldLabel spec={spec} htmlFor={`union-${spec.label}`} />
      <div className="flex gap-2">
        <select
          value={usableType}
          onChange={(e) => {
            const t = e.target.value as typeof pickedType
            setPickedType(t)
            // Reset value to a sensible default for the new type.
            if (t === "string") onChange("")
            else if (t === "number") onChange(0)
            else if (t === "boolean") onChange(false)
            else onChange(null)
          }}
          className={`${inputClassName(false)} max-w-[110px]`}
        >
          {spec.allowed.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        {usableType === "string" && (
          <input
            type="text"
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
            className={inputClassName(!!fieldErrors)}
          />
        )}
        {usableType === "number" && (
          <input
            type="number"
            value={typeof value === "number" ? String(value) : ""}
            onChange={(e) => {
              const n = parseFloat(e.target.value)
              onChange(Number.isNaN(n) ? undefined : n)
            }}
            className={inputClassName(!!fieldErrors)}
          />
        )}
        {usableType === "boolean" && (
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={value === true}
              onChange={(e) => onChange(e.target.checked)}
              className="rounded border-zinc-300"
            />
            true / false
          </label>
        )}
        {usableType === "null" && (
          <input
            type="text"
            value="null"
            readOnly
            className={`${inputClassName(false)} bg-zinc-50 text-zinc-500 max-w-[100px]`}
          />
        )}
      </div>
      <FieldHelp spec={spec} />
      <FieldErrors messages={fieldErrors} />
    </div>
  )
}

function JsonField({ spec, value, onChange, fieldErrors, bare }: SubFieldProps) {
  const [text, setText] = useState(() => (value === undefined ? "" : JSON.stringify(value, null, 2)))
  const [parseError, setParseError] = useState<string | null>(null)

  return (
    <div className={bare ? "" : "mb-3"}>
      <FieldLabel spec={spec} htmlFor={`json-${spec.label}`} />
      <textarea
        value={text}
        rows={6}
        onChange={(e) => {
          const v = e.target.value
          setText(v)
          if (v.trim() === "") {
            setParseError(null)
            onChange(undefined)
            return
          }
          try {
            const parsed = JSON.parse(v)
            setParseError(null)
            onChange(parsed)
          } catch (err) {
            setParseError(err instanceof Error ? err.message : "invalid JSON")
          }
        }}
        className={`${inputClassName(!!fieldErrors || !!parseError)} font-mono text-xs`}
        placeholder='{ "key": "value" }'
      />
      {parseError && <p className="mt-1 text-[11px] text-red-600">JSON: {parseError}</p>}
      {spec.kind === "unsupported" && (
        <p className="mt-1 text-[11px] text-amber-700">
          Advanced (JSON): {spec.reason}
        </p>
      )}
      <FieldHelp spec={spec} />
      <FieldErrors messages={fieldErrors} />
    </div>
  )
}
