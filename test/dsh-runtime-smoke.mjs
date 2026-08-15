import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const checkout = process.env.DSH_CHECKOUT
if (!checkout) throw new Error('DSH_CHECKOUT must point to a built DeepSeek Harness checkout')
const pluginEntry = process.env.PLUGIN_ENTRY
const plugin = pluginEntry ? await import(pathToFileURL(resolve(pluginEntry)).href) : await import('../index.js')
const importBuilt = relative => import(pathToFileURL(resolve(checkout, relative)).href)
const { Context } = await importBuilt('vendor/cordis/lib/index.js')
const { default: SystemPrompt } = await importBuilt('packages/core/system-prompt/lib/index.js')
const { default: ToolRuntime } = await importBuilt('packages/core/tools/lib/index.js')
const { TokenMeter } = await importBuilt('packages/llm/token-meter/lib/index.js')

const hash = value => createHash('sha256').update(value).digest('hex')
const root = await mkdtemp(join(tmpdir(), 'dsh-lineage-runtime-'))
const objects = { 'source.json': 'source\n', 'action.json': 'action\n', 'report.json': 'report\n' }
for (const [name, content] of Object.entries(objects)) await writeFile(join(root, name), content)
const events = [
  { eventVersion: 1, idempotencyKey: 'source-v1', op: 'put-node', node: { id: 'artifact:source', type: 'artifact', ref: { path: 'source.json', sha256: hash(objects['source.json']) } } },
  { eventVersion: 1, idempotencyKey: 'action-v1', op: 'put-node', node: { id: 'action:build', type: 'action', ref: { path: 'action.json', sha256: hash(objects['action.json']) } } },
  { eventVersion: 1, idempotencyKey: 'report-v1', op: 'put-node', node: { id: 'report:proof', type: 'report', ref: { path: 'report.json', sha256: hash(objects['report.json']) } } },
  { eventVersion: 1, idempotencyKey: 'derived-v1', op: 'put-edge', edge: { id: 'edge:derived', type: 'derived-from', from: 'action:build', to: 'artifact:source' } },
  { eventVersion: 1, idempotencyKey: 'produced-v1', op: 'put-edge', edge: { id: 'edge:produced', type: 'produced-by', from: 'report:proof', to: 'action:build' } }
]
await writeFile(join(root, 'events.jsonl'), `${events.map(value => JSON.stringify(value)).join('\n')}\n`)

const ctx = new Context()
try {
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(plugin, { workspaceRoot: root })
  const tools = ctx.get('tools')
  const names = tools.schemas().filter(({ name }) => name.startsWith('dsh_lineage_')).map(({ name }) => name)
  assert.deepEqual(names, ['dsh_lineage_inspect', 'dsh_lineage_ingest', 'dsh_lineage_query', 'dsh_lineage_verify'])
  const ingest = await tools.execute({ signal: new AbortController().signal, callId: 'lineage-ingest', name: 'dsh_lineage_ingest', arguments: { ledgerDir: 'ledger', eventsPath: 'events.jsonl' } }, {})
  assert.equal(ingest.isError, false)
  assert.equal(ingest.value.healthy, true)
  const verify = await tools.execute({ signal: new AbortController().signal, callId: 'lineage-verify', name: 'dsh_lineage_verify', arguments: { ledgerDir: 'ledger', nodeId: 'report:proof', direction: 'upstream', artifactDir: 'artifacts' } }, {})
  assert.equal(verify.isError, false)
  assert.equal(verify.value.passed, true)
  assert.equal(verify.value.artifact.verifiedByReadBack, true)
  process.stdout.write(`${JSON.stringify({ ok: true, dshTools: names, ledgerFingerprint: ingest.value.ledgerFingerprint, artifact: verify.value.artifact })}\n`)
} finally {
  await ctx.fiber.dispose()
}
