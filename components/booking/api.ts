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
  if (!res.ok) throw new Error(typeof data.error === "string" && data.error ? data.error : fallback)
  return data as T
}

export function messageOf(err: unknown, fallback = "Something went wrong. Please try again."): string {
  return err instanceof Error && err.message ? err.message : fallback
}
