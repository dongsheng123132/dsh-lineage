import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import test from 'node:test'

test('CLI ingests an append-only JSONL ledger', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lineage-cli-'))
  const value = '{"ok":true}\n'
  await writeFile(join(root, 'artifact.json'), value)
  const event = { eventVersion: 1, idempotencyKey: 'cli-v1', op: 'put-node', node: { id: 'artifact:cli', type: 'artifact', ref: { path: 'artifact.json', sha256: createHash('sha256').update(value).digest('hex') } } }
  await writeFile(join(root, 'events.jsonl'), `${JSON.stringify(event)}\n`)
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/dsh-lineage.mjs', import.meta.url)), 'ingest', '--root', root, '--ledger', 'ledger', '--events', 'events.jsonl'])
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, stderr)
  const result = JSON.parse(stdout)
  assert.equal(result.healthy, true)
  assert.equal(result.writes[0].status, 'written')
})
