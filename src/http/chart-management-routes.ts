/** The admin-gated chart management routes: list the detected charts with their parsed header and
 * validation status, and set a per-chart name, description, and scale override. These mount under
 * /api so the admin gate covers them; the serve route stays open read-only. */

import type { ServerAPI } from '@signalk/server-api'
import { type ChartRegistry, chartResource } from '../charts/chart-registry.js'
import type { ChartOverride, OverrideStore } from '../charts/overrides.js'
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
  get (path: string, handler: (req: ManagementRequest, res: ManagementResponse) => void): void
  post (path: string, handler: (req: ManagementRequest, res: ManagementResponse) => void): void
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readOverride (body: unknown): ChartOverride | undefined {
  if (!isRecord(body)) return undefined
  const override: ChartOverride = {}
  if (typeof body.name === 'string') override.name = body.name
  if (typeof body.description === 'string') override.description = body.description
  if (typeof body.scale === 'number' && Number.isFinite(body.scale)) override.scale = body.scale
  return override
}

/** Mount the chart-management routes behind the admin gate. Returns whether they were mounted, so the
 *  registrar self-gates and fails closed like the regions and cache-info registrars, rather than relying
 *  on the caller to gate it. */
export function registerChartManagementRoutes (
  router: ManagementRouter,
  app: ServerAPI,
  registry: ChartRegistry,
  overrides: OverrideStore,
  onOverride: () => void
): boolean {
  if (!ensureApiAdminGate(app)) return false
  router.get('/api/charts', (_req, res) => {
    res.json({
      charts: registry.records().map((record) => ({
        ...chartResource(record),
        fileName: record.fileName,
        override: overrides.get(record.identifier) ?? {}
      })),
      invalid: registry.errors()
    })
  })

  router.post('/api/charts/:id/override', (req, res) => {
    if (!registry.has(req.params.id)) {
      res.status(404).json({ error: `Unknown chart: ${req.params.id}` })
      return
    }
    const override = readOverride(req.body)
    if (!override) {
      res.status(400).json({ error: 'Body must be an object with name, description, or scale.' })
      return
    }
    overrides.set(req.params.id, override)
    onOverride()
    // Return the merged stored override, not just the posted patch, so the caller sees the effective value.
    res.json({ identifier: req.params.id, override: overrides.get(req.params.id) ?? {} })
  })
  return true
}
