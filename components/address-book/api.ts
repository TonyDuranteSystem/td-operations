/** Address book — the browser's way of calling the address book routes. A failed call throws the server's own plain-English reason (R099), never a bare "failed". */

export interface ApiFailure extends Error {
  status: number
  data: Record<string, unknown>
}

export async function callApi<T = Record<string, unknown>>(
  url: string,
  init: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown } = {},
  fallback = "Something went wrong. Please try again.",
): Promise<T> {
  // every call that changes something must carry the JSON header the server's same-origin check asks for, even one with nothing to send (a DELETE)
  const method = init.method ?? "GET"
  const changes = method !== "GET"
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers: changes ? { "Content-Type": "application/json" } : undefined,
      body: changes ? JSON.stringify(init.body ?? {}) : undefined,
      cache: "no-store",
    })
  } catch {
    throw new Error("The connection dropped. Check your internet and try again.")
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const err = new Error(typeof data.error === "string" && data.error ? data.error : fallback) as ApiFailure
    err.status = res.status
    err.data = data
    throw err
  }
  return data as T
}

export function messageOf(err: unknown, fallback = "Something went wrong. Please try again."): string {
  return err instanceof Error && err.message ? err.message : fallback
}
