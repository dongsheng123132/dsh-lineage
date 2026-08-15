import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

const hash = value => createHash('sha256').update(value).digest('hex')
const events = [
  { eventVersion: 1, idempotencyKey: 'source-v1', op: 'put-node', node: { id: 'artifact:source', type: 'artifact', ref: { path: 'source.json', sha256: hash('source') } } },
  { eventVersion: 1, idempotencyKey: 'action-v1', op: 'put-node', node: { id: 'action:build', type: 'action', ref: { path: 'action.json', sha256: hash('action') } } },
  { eventVersion: 1, idempotencyKey: 'report-v1', op: 'put-node', node: { id: 'report:proof', type: 'report', ref: { path: 'report.json', sha256: hash('report') } } },
  { eventVersion: 1, idempotencyKey: 'derived-v1', op: 'put-edge', edge: { id: 'edge:derived', type: 'derived-from', from: 'action:build', to: 'artifact:source' } },
  { eventVersion: 1, idempotencyKey: 'produced-v1', op: 'put-edge', edge: { id: 'edge:produced', type: 'produced-by', from: 'report:proof', to: 'action:build' } }
]
const eventsJsonl = `${events.map(value => JSON.stringify(value)).join('\n')}\n`
const forbidden = structuredClone(events)
forbidden[0].apiToken = 'do-not-echo'
const forbiddenJsonl = `${forbidden.map(value => JSON.stringify(value)).join('\n')}\n`

const child = spawn(process.execPath, ['mcp-server.mjs'], { cwd: process.cwd(), shell: false, stdio: ['pipe', 'pipe', 'inherit'] })
let output = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', chunk => { output += chunk })
const request = value => child.stdin.write(`${JSON.stringify(value)}\n`)
request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
request({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
request({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'lineage_events_inspect', arguments: { eventsJsonl } } })
request({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'lineage_events_query', arguments: { eventsJsonl, nodeId: 'report:proof', direction: 'upstream' } } })
request({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'lineage_events_inspect', arguments: { eventsJsonl: forbiddenJsonl } } })
child.stdin.end()
await new Promise((resolve, reject) => {
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`MCP exited ${code}`)))
  child.on('error', reject)
})
const messages = output.trim().split(/\r?\n/).map(JSON.parse)
assert.equal(messages[0].result.serverInfo.version, '0.2.0')
assert.deepEqual(messages[1].result.tools.map(({ name }) => name), ['lineage_events_inspect', 'lineage_events_query'])
assert.equal(messages[2].result.structuredContent.structurallyHealthy, true)
assert.deepEqual(messages[3].result.structuredContent.nodeIds, ['action:build', 'artifact:source', 'report:proof'])
assert.match(messages[4].error.message, /forbidden raw-content or secret-bearing field/)
assert.doesNotMatch(output, /do-not-echo/)
process.stdout.write(`${JSON.stringify({ ok: true, tools: messages[1].result.tools.map(({ name }) => name), proofOnly: true, secretFieldRejected: true })}\n`)
