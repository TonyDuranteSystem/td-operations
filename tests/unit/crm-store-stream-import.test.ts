import { describe, it, expect } from "vitest"
import { createHash } from "crypto"
import { Readable } from "stream"
import { pipeline } from "stream/promises"
import { STREAM_THRESHOLD_BYTES, STREAM_MAX_BYTES, MERGE_MAX_BYTES, transferMode, mergeTooLarge, streamTooLarge, hashingPassThrough } from "@/lib/crm-store/stream-import"

const MB = 1024 * 1024

describe("big files from Drive: how the bytes travel", () => {
  it("a lone file streams only above the threshold; small files keep the old path", () => {
    expect(transferMode(1 * MB, 0)).toBe("buffer")
    expect(transferMode(STREAM_THRESHOLD_BYTES, 0)).toBe("buffer")
    expect(transferMode(STREAM_THRESHOLD_BYTES + 1, 0)).toBe("stream")
    expect(transferMode(80 * MB, 0)).toBe("stream")
    expect(transferMode(5 * 1024 * MB, 0)).toBe("stream")
  })

  it("a document merged with certificates always buffers (the merge is built in memory), whatever its size", () => {
    expect(transferMode(1 * MB, 1)).toBe("buffer")
    expect(transferMode(80 * MB, 2)).toBe("buffer")
  })

  it("only a MERGED document has a size ceiling", () => {
    expect(mergeTooLarge(MERGE_MAX_BYTES, 1)).toBe(false)
    expect(mergeTooLarge(MERGE_MAX_BYTES + 1, 1)).toBe(true)
    expect(mergeTooLarge(500 * MB, 0)).toBe(false)
  })
})

describe("the build-request time ceiling (not a storage limit)", () => {
  it("only a lone file over the measured ceiling is refused, with a message that points to the upload button", () => {
    expect(streamTooLarge(STREAM_MAX_BYTES, 0)).toBe(false)
    expect(streamTooLarge(STREAM_MAX_BYTES + 1, 0)).toBe(true)
    expect(streamTooLarge(STREAM_MAX_BYTES + 1, 1)).toBe(false) // a merge is handled (refused) by the merge ceiling instead
    expect(STREAM_MAX_BYTES).toBeGreaterThan(STREAM_THRESHOLD_BYTES)
  })
})

describe("hashingPassThrough", () => {
  it("passes every byte through unchanged and reports the same md5, sha256 and length as hashing the whole file", async () => {
    const parts = [Buffer.from("hello "), Buffer.alloc(0), Buffer.from("big "), Buffer.alloc(100_000, 7), Buffer.from("world")]
    const whole = Buffer.concat(parts)
    const { stream, digest } = hashingPassThrough()
    const out: Buffer[] = []
    stream.on("data", (c: Buffer) => out.push(c))
    await pipeline(Readable.from(parts), stream)
    expect(Buffer.concat(out).equals(whole)).toBe(true)
    const d = digest()
    expect(d.bytes).toBe(whole.length)
    expect(d.md5).toBe(createHash("md5").update(whole).digest("hex"))
    expect(d.sha256).toBe(createHash("sha256").update(whole).digest("hex"))
  })

  it("an empty stream hashes to the empty-file digests", async () => {
    const { stream, digest } = hashingPassThrough()
    stream.resume()
    await pipeline(Readable.from([]), stream)
    expect(digest()).toEqual({ md5: "d41d8cd98f00b204e9800998ecf8427e", sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", bytes: 0 })
  })
})
