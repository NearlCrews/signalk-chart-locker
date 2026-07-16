/** A pmtiles Source backed by a local file, so the JS pmtiles library can decode an archive
 * off disk in process. This replaces the third-party plugin's metadata read over loopback HTTP. */

import { open } from 'node:fs/promises'
import type { RangeResponse, Source } from 'pmtiles'

interface PmtilesFileSourceDeps {
  open?: typeof open
}

/** A defensive ceiling for one metadata or directory read during discovery. */
export const MAX_PMTILES_DISCOVERY_READ_BYTES = 16 * 1024 * 1024

export class PmtilesFileSource implements Source {
  readonly #filePath: string
  readonly #open: typeof open

  constructor (filePath: string, deps: PmtilesFileSourceDeps = {}) {
    this.#filePath = filePath
    this.#open = deps.open ?? open
  }

  getKey (): string {
    return this.#filePath
  }

  async getBytes (offset: number, length: number, signal?: AbortSignal): Promise<RangeResponse> {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 ||
        length > MAX_PMTILES_DISCOVERY_READ_BYTES || !Number.isSafeInteger(offset + length)) {
      throw new RangeError('PMTiles byte range is invalid or too large')
    }
    const handle = await this.#open(this.#filePath, 'r')
    try {
      const info = await handle.stat()
      if (offset > info.size) throw new RangeError('PMTiles byte range starts beyond the archive')
      const available = Math.min(length, info.size - offset)
      const buffer = Buffer.alloc(available)
      let bytesRead = 0
      while (bytesRead < available) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        const result = await handle.read(buffer, bytesRead, available - bytesRead, offset + bytesRead)
        if (result.bytesRead === 0) break
        bytesRead += result.bytesRead
      }
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const view = buffer.subarray(0, bytesRead)
      // Return a tight ArrayBuffer copy of exactly the bytes read, never the padded allocation.
      return { data: view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) }
    } finally {
      await handle.close()
    }
  }
}
