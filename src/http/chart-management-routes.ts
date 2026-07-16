/** The admin-gated chart management routes: list the detected charts with their parsed header and
 * validation status, and set a per-chart name, description, and scale override. These mount under
 * /api so the admin gate covers them; the serve route stays open read-only. */

import type { ServerAPI } from '@signalk/server-api'
import { type ChartRegistry, chartResource } from '../charts/chart-registry.js'
import { readChartOverride, type ChartOverride, type OverrideStore } from '../charts/overrides.js'
import { ensureApiAdminGate } from '../shared/admin-gate.js'

export interface ManagementRequest {
  params: Record<string, string>
  body: unknown
}

export interface ManagementResponse {
  json (body: unknown): void
  status (code: number): ManagementResponse
}

export interface ManagementRouter {
  get (path: string, handler: (req: ManagementRequest, res: ManagementResponse) => void | Promise<void>): void
  post (path: string, handler: (req: ManagementRequest, res: ManagementResponse) => void | Promise<void>): void
}

function readOverride (body: unknown): ChartOverride | undefined {
  return readChartOverride(body)
}

/** Mount the chart-management routes behind the admin gate. Returns whether they were mounted, so the
 *  registrar self-gates and fails closed like the regions and cache-info registrars, rather than relying
 *  on the caller to gate it. */
export function registerChartManagementRoutes (
  router: ManagementRouter,
  app: ServerAPI,
  registry: ChartRegistry,
  overrides: OverrideStore,
  onRescan: () => void | Promise<void>,
  isEnabled: () => boolean = () => true
): boolean {
  if (!ensureApiAdminGate(app)) return false
  router.get('/api/charts', (_req, res) => {
    if (!isEnabled()) {
      res.status(409).json({ error: 'PMTiles management is disabled while pmtiles-chart-provider is enabled' })
      return
    }
    res.json({
      charts: registry.records().map((record) => ({
        ...chartResource(record),
        fileName: record.fileName,
        override: overrides.get(record.identifier) ?? {}
      })),
      invalid: registry.errors(),
      discovery: registry.discoveryStatus()
    })
  })

  router.post('/api/charts/:id/override', async (req, res) => {
    if (!isEnabled()) {
      res.status(409).json({ error: 'PMTiles management is disabled while pmtiles-chart-provider is enabled' })
      return
    }
    if (!registry.has(req.params.id)) {
      res.status(404).json({ error: `Unknown chart: ${req.params.id}` })
      return
    }
    const override = readOverride(req.body)
    if (!override) {
      res.status(400).json({ error: 'Body must be an object with name, description, or scale.' })
      return
    }
    try {
      // OverrideStore writes the next snapshot before publishing it in memory, so a failed write leaves
      // both the live registry naming and the previous durable state unchanged.
      overrides.set(req.params.id, override)
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
      res.status(code === 'ENOSPC' || code === 'EDQUOT' ? 507 : 500).json({ error: 'unable to persist chart override' })
      return
    }
    try {
      await onRescan()
      // Return the merged stored override, not just the posted patch, so the caller sees the effective value.
      res.json({ identifier: req.params.id, override: overrides.get(req.params.id) ?? {} })
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  router.post('/api/charts/rescan', async (_req, res) => {
    if (!isEnabled()) {
      res.status(409).json({ error: 'PMTiles management is disabled while pmtiles-chart-provider is enabled' })
      return
    }
    try {
      await onRescan()
      res.json({ discovery: registry.discoveryStatus() })
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  return true
}
