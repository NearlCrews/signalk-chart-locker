/** The shared warm client: POST a warm to the tilecache container and poll it to a terminal result. The
 * position-warm loop uses it so the warm POST and the status poll are spelled once, not re-rolled inline.
 * Returns the terminal { errors, total }, or null on any failure or a job the container no longer has. */

export interface WarmResult {
  errors: number
  total: number
}

const POLL_ATTEMPTS = 20
const POLL_INTERVAL_MS = 500

export async function warmRegion (
  address: string,
  req: { bbox: [number, number, number, number], sources: string[], minzoom: number, maxzoom: number },
  fetchImpl: typeof fetch = fetch
): Promise<WarmResult | null> {
  try {
    const start = await fetchImpl(`http://${address}/warm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req)
    })
    if (!start.ok) return null
    const { jobId } = (await start.json()) as { jobId: string }
    // Poll briefly so the caller learns whether the warm was all-errors (offline) for its backoff decision.
    for (let i = 0; i < POLL_ATTEMPTS; i++) {
      const status = await fetchImpl(`http://${address}/warm/${encodeURIComponent(jobId)}`)
      if (status.status === 404) return null
      const snap = (await status.json()) as { errors: number, total: number, state: string }
      if (snap.state !== 'running') return { errors: snap.errors, total: snap.total }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    }
    return null
  } catch {
    return null
  }
}
