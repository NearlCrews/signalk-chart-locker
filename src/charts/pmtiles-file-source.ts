/** A pmtiles Source backed by a local file, so the JS pmtiles library can decode an archive
 * off disk in process. This replaces the third-party plugin's metadata read over loopback HTTP. */

import { open } from 'node:fs/promises'
import type { RangeResponse, Source } from 'pmtiles'

export class PmtilesFileSource implements Source {
  readonly #filePath: string

  constructor (filePath: string) {
    this.#filePath = filePath
  }

  getKey (): string {
    return this.#filePath
  }

  async getBytes (offset: number, length: number, signal?: AbortSignal): Promise<RangeResponse> {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }
    const handle = await open(this.#filePath, 'r')
    try {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, offset)
      const view = buffer.subarray(0, bytesRead)
      // Return a tight ArrayBuffer copy of exactly the bytes read, never the padded allocation.
      return { data: view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) }
    } finally {
      await handle.close()
    }
  }
}
