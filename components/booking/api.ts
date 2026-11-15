/** Booking page — the browser's way of calling the admin routes. A failed call throws the server's own plain-English reason (R099), never a bare "failed". */

export async function callApi<T = Record<string, unknown>>(url: string, init: { method?: "GET" | "POST" | "PATCH"; body?: unknown } = {}, fallback = "Something went wrong. Please try again."): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      headers: init.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    })
  } catch {
    throw new Error("The connection dropped. Check your internet and try again.")
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    // the whole answer rides along on the error, for the few calls whose refusal carries more than words (the cancel route's fallback address)
    const err = new Error(typeof data.error === "string" && data.error ? data.error : fallback) as Error & { data?: Record<string, unknown> }
    err.data = data
    throw err
  }
  return data as T
}

/** The server's whole answer to a refused call, if it sent one. */
export function dataOf(err: unknown): Record<string, unknown> {
  const d = err instanceof Error ? (err as Error & { data?: unknown }).data : undefined
  return d && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : {}
}

export function messageOf(err: unknown, fallback = "Something went wrong. Please try again."): string {
  return err instanceof Error && err.message ? err.message : fallback
}
