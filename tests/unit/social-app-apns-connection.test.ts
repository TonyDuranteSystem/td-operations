/**
 * TD Social — the real HTTP/2 connection code, against a local fake Apple (dev job 2072bc3e, Step 2 pull request C2). The fake is a plain-text HTTP/2 server on this
 * machine: it answers like Apple (status plus a JSON reason), goes silent, or hangs up, so the connection code's timeout, cancel, goaway and close paths run for real.
 */
import { describe, it, expect, afterEach } from "vitest"
import http2 from "node:http2"
import type { AddressInfo } from "node:net"
import { sessionOver } from "@/lib/app/apns"

const REQ = { path: "/3/device/" + "ab".repeat(32), headers: { "apns-topic": "x" }, body: "{}" }

let server: http2.Http2Server | undefined
let sessions: http2.ServerHttp2Session[] = []
const clients: http2.ClientHttp2Session[] = []

async function fakeApple(onRequest: (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => void) {
  sessions = []
  server = http2.createServer()
  server.on("session", s => { sessions.push(s) })
  server.on("stream", onRequest)
  await new Promise<void>(r => server!.listen(0, "127.0.0.1", r))
  const client = http2.connect(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`)
  clients.push(client)
  return sessionOver(client)
}

afterEach(async () => {
  for (const c of clients.splice(0)) { try { c.destroy() } catch { /* gone */ } }
  for (const s of sessions) { try { s.destroy() } catch { /* gone */ } }
  await new Promise<void>(r => (server ? server.close(() => r()) : r()))
  server = undefined
})

describe("sessionOver: the real connection code, against a local fake Apple", () => {
  it("a 200 comes back as a plain success", async () => {
    const s = await fakeApple(st => { st.respond({ ":status": 200 }); st.end() })
    expect(await s.send(REQ, 2000)).toEqual({ status: 200, reason: null })
    s.close()
  })

  it("an Apple-style refusal gives its status and its short reason", async () => {
    const s = await fakeApple(st => { st.respond({ ":status": 410, "content-type": "application/json" }); st.end(JSON.stringify({ reason: "Unregistered" })) })
    expect(await s.send(REQ, 2000)).toEqual({ status: 410, reason: "Unregistered" })
    s.close()
  })

  it("sends the request exactly as built: method, path, headers and body", async () => {
    let seen: { method?: unknown; path?: unknown; topic?: unknown; body: string } = { body: "" }
    const s = await fakeApple((st, h) => {
      st.setEncoding("utf8"); st.on("data", d => { seen.body += d })
      st.on("end", () => { seen = { ...seen, method: h[":method"], path: h[":path"], topic: h["apns-topic"] }; st.respond({ ":status": 200 }); st.end() })
    })
    await s.send({ ...REQ, body: '{"aps":{}}' }, 2000)
    expect(seen).toEqual({ method: "POST", path: REQ.path, topic: "x", body: '{"aps":{}}' })
    s.close()
  })

  it("two requests share the one connection", async () => {
    const s = await fakeApple(st => { st.respond({ ":status": 200 }); st.end() })
    const [a, b] = await Promise.all([s.send(REQ, 2000), s.send(REQ, 2000)])
    expect([a.status, b.status]).toEqual([200, 200])
    expect(sessions).toHaveLength(1)
    s.close()
  })

  it("a silent Apple: the request times out, is CANCELLED on the wire, and the next one still works", async () => {
    let cancelled = false
    let n = 0
    const s = await fakeApple(st => {
      n++
      if (n === 1) { st.on("close", () => { cancelled = st.rstCode === http2.constants.NGHTTP2_CANCEL }); return } // never answers
      st.respond({ ":status": 200 }); st.end()
    })
    await expect(s.send(REQ, 150)).rejects.toThrow("timeout")
    await new Promise(r => setTimeout(r, 100))
    expect(cancelled).toBe(true)
    expect((await s.send(REQ, 2000)).status).toBe(200)
    s.close()
  })

  it("a hostile, enormous response body is cut and its reason is not trusted", async () => {
    const s = await fakeApple(st => { st.respond({ ":status": 400 }); st.end("x".repeat(500_000)) })
    expect(await s.send(REQ, 3000)).toEqual({ status: 400, reason: null })
    s.close()
  })

  it("Apple hanging up (goaway) makes later requests fail fast instead of hanging", async () => {
    const s = await fakeApple(st => { st.respond({ ":status": 200 }); st.end() })
    expect((await s.send(REQ, 2000)).status).toBe(200)
    sessions[0].goaway()
    await new Promise(r => setTimeout(r, 100))
    await expect(s.send(REQ, 1000)).rejects.toThrow()
    s.close()
  })

  it("a connection that dies mid-request rejects (it never hangs and never reports success)", async () => {
    const s = await fakeApple(st => { setTimeout(() => sessions[0].destroy(), 20); void st })
    await expect(s.send(REQ, 3000)).rejects.toThrow()
    s.close()
  })

  it("a request after close is refused, and closing twice is harmless", async () => {
    const s = await fakeApple(st => { st.respond({ ":status": 200 }); st.end() })
    s.close(); s.close()
    await expect(s.send(REQ, 500)).rejects.toThrow()
  })
})
