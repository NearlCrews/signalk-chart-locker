import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isThirdPartyPmtilesEnabled } from '../src/charts/mutual-exclusion.js'

async function configDir (contents?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cfg-'))
  if (contents !== undefined) {
    await mkdir(join(dir, 'plugin-config-data'), { recursive: true })
    await writeFile(join(dir, 'plugin-config-data', 'pmtiles-chart-provider.json'), contents)
  }
  return dir
}

test('reports true when the third-party plugin config is present and enabled', async () => {
  const dir = await configDir(JSON.stringify({ enabled: true, configuration: {} }))
  try {
    assert.equal(isThirdPartyPmtilesEnabled(dir), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reports false when the config exists but is disabled', async () => {
  const dir = await configDir(JSON.stringify({ enabled: false }))
  try {
    assert.equal(isThirdPartyPmtilesEnabled(dir), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reports false when no third-party config file exists', async () => {
  const dir = await configDir()
  try {
    assert.equal(isThirdPartyPmtilesEnabled(dir), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reports false when config file is malformed JSON', async () => {
  const dir = await configDir('not valid json at all {')
  try {
    assert.equal(isThirdPartyPmtilesEnabled(dir), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
