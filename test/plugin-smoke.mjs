import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDefinitions } from '../index.js'
import * as plugin from '../index.js'

const hash = value => createHash('sha256').update(value).digest('hex')
assert.equal('default' in plugin, false, 'a default export makes the real DSH Loader discard namespace inject metadata')
assert.equal(plugin.name, 'dsh-lineage')
assert.deepEqual(plugin.inject, ['tools'])
const root = await mkdtemp(join(tmpdir(), 'dsh-lineage-plugin-'))
const source = '{"artifact":"source"}\n'
const action = '{"action":"build"}\n'
const report = '{"report":"proof"}\n'
await writeFile(join(root, 'source.json'), source)
await writeFile(join(root, 'action.json'), action)
await writeFile(join(root, 'report.json'), report)
const events = [
  { eventVersion: 1, idempotencyKey: 'source-v1', op: 'put-node', node: { id: 'artifact:source', type: 'artifact', ref: { path: 'source.json', sha256: hash(source) } } },
  { eventVersion: 1, idempotencyKey: 'action-v1', op: 'put-node', node: { id: 'action:build', type: 'action', ref: { path: 'action.json', sha256: hash(action) } } },
  { eventVersion: 1, idempotencyKey: 'report-v1', op: 'put-node', node: { id: 'report:proof', type: 'report', ref: { path: 'report.json', sha256: hash(report) } } },
  { eventVersion: 1, idempotencyKey: 'derived-v1', op: 'put-edge', edge: { id: 'edge:derived', type: 'derived-from', from: 'action:build', to: 'artifact:source' } },
  { eventVersion: 1, idempotencyKey: 'produced-v1', op: 'put-edge', edge: { id: 'edge:produced', type: 'produced-by', from: 'report:proof', to: 'action:build' } }
]
await writeFile(join(root, 'events.jsonl'), `${events.map(value => JSON.stringify(value)).join('\n')}\n`)
const tools = createDefinitions({}, { workspaceRoot: root })
assert.deepEqual(tools.map(tool => tool.name), ['dsh_lineage_inspect', 'dsh_lineage_ingest', 'dsh_lineage_query', 'dsh_lineage_verify'])
const ingested = await tools[1].execute({ ledgerDir: 'ledger', eventsPath: 'events.jsonl' })
assert.equal(ingested.healthy, true)
const inspection = await tools[0].execute({ ledgerDir: 'ledger' })
assert.equal(inspection.eventCount, 5)
const query = await tools[2].execute({ ledgerDir: 'ledger', nodeId: 'report:proof', direction: 'upstream' })
assert.equal(query.nodeIds.length, 3)
const verified = await tools[3].execute({ ledgerDir: 'ledger', nodeId: 'report:proof', direction: 'upstream', artifactDir: 'artifacts' })
assert.equal(verified.passed, true)
assert.equal(verified.artifact.verifiedByReadBack, true)
console.log(JSON.stringify({ ok: true, namespacePlugin: true, inject: plugin.inject, tools: tools.map(tool => tool.name), ledgerFingerprint: ingested.ledgerFingerprint, artifact: verified.artifact }))
