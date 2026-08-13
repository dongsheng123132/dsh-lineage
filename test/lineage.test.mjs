import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ingestLineage, inspectLineage, normalizeEvent, queryLineage, verifyLineage } from '../lib/lineage.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')

function node(key, id, type, path, sha256) {
  return { eventVersion: 1, idempotencyKey: key, op: 'put-node', node: { id, type, ref: { path, sha256 } } }
}

function edge(key, id, type, from, to) {
  return { eventVersion: 1, idempotencyKey: key, op: 'put-edge', edge: { id, type, from, to } }
}

async function workspace(events, files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lineage-'))
  for (const [path, value] of Object.entries(files)) {
    const directory = join(root, ...path.split('/').slice(0, -1))
    await mkdir(directory, { recursive: true })
    await writeFile(join(root, path), value)
  }
  await writeFile(join(root, 'events.jsonl'), `${events.map(value => JSON.stringify(value)).join('\n')}\n`)
  return root
}

test('incrementally ingests content-addressed nodes and queries both directions', async () => {
  const source = '{"value":1}\n'
  const action = '{"action":"normalize","status":"done"}\n'
  const report = '{"result":"ok"}\n'
  const events = [
    node('source-v1', 'artifact:source', 'artifact', 'objects/source.json', hash(source)),
    node('action-v1', 'action:normalize', 'action', 'objects/action.json', hash(action)),
    node('report-v1', 'report:result', 'report', 'objects/report.json', hash(report)),
    edge('edge-produced', 'edge:produced', 'produced-by', 'report:result', 'action:normalize'),
    edge('edge-derived', 'edge:derived', 'derived-from', 'action:normalize', 'artifact:source')
  ]
  const root = await workspace(events, { 'objects/source.json': source, 'objects/action.json': action, 'objects/report.json': report })
  const first = await ingestLineage({ workspaceRoot: root, ledgerDir: 'ledger', eventsPath: 'events.jsonl' })
  assert.equal(first.eventCount, 5)
  assert.equal(first.writes.every(item => item.status === 'written'), true)
  assert.equal(first.healthy, true)
  const replay = await ingestLineage({ workspaceRoot: root, ledgerDir: 'ledger', eventsPath: 'events.jsonl' })
  assert.equal(replay.writes.every(item => item.status === 'replayed'), true)

  const upstream = await queryLineage({ workspaceRoot: root, ledgerDir: 'ledger', nodeId: 'report:result', direction: 'upstream' })
  assert.deepEqual(upstream.nodeIds, ['action:normalize', 'artifact:source', 'report:result'])
  const downstream = await queryLineage({ workspaceRoot: root, ledgerDir: 'ledger', nodeId: 'artifact:source', direction: 'downstream' })
  assert.deepEqual(downstream.nodeIds, ['action:normalize', 'artifact:source', 'report:result'])

  const verified = await verifyLineage({ workspaceRoot: root, ledgerDir: 'ledger', nodeId: 'report:result', direction: 'upstream', artifactDir: 'artifacts' })
  assert.equal(verified.passed, true)
  assert.equal(verified.artifact.verifiedByReadBack, true)
  assert.equal(hash(await readFile(join(root, verified.artifact.path))), verified.artifact.sha256)
})

test('discloses missing, stale and dangling evidence without inventing facts', async () => {
  const original = 'original\n'
  const events = [
    node('artifact-v1', 'artifact:stale', 'artifact', 'objects/stale.bin', hash(original)),
    node('fact-v1', 'fact:missing', 'fact', 'objects/missing.json', hash('missing\n')),
    edge('edge-dangling', 'edge:dangling', 'observed-by', 'fact:missing', 'report:absent')
  ]
  const root = await workspace(events, { 'objects/stale.bin': 'changed\n' })
  const result = await ingestLineage({ workspaceRoot: root, ledgerDir: 'ledger', eventsPath: 'events.jsonl' })
  assert.equal(result.healthy, false)
  assert.deepEqual(result.disclosure.missing, ['fact:missing'])
  assert.deepEqual(result.disclosure.stale, ['artifact:stale'])
  assert.deepEqual(result.disclosure.dangling[0].missing, ['report:absent'])
  const inspection = await inspectLineage({ workspaceRoot: root, ledgerDir: 'ledger' })
  assert.equal(inspection.healthy, false)
})

test('rejects cycles before any cyclic event is published', async () => {
  const value = 'x\n'
  const initial = [
    node('a-node', 'artifact:a', 'artifact', 'a.txt', hash(value)),
    node('b-node', 'artifact:b', 'artifact', 'b.txt', hash(value)),
    edge('a-to-b', 'edge:a-b', 'derived-from', 'artifact:a', 'artifact:b')
  ]
  const root = await workspace(initial, { 'a.txt': value, 'b.txt': value })
  await ingestLineage({ workspaceRoot: root, ledgerDir: 'ledger', eventsPath: 'events.jsonl' })
  await writeFile(join(root, 'cycle.jsonl'), `${JSON.stringify(edge('b-to-a', 'edge:b-a', 'derived-from', 'artifact:b', 'artifact:a'))}\n`)
  await assert.rejects(ingestLineage({ workspaceRoot: root, ledgerDir: 'ledger', eventsPath: 'cycle.jsonl' }), /cycle/)
  const inspection = await inspectLineage({ workspaceRoot: root, ledgerDir: 'ledger' })
  assert.equal(inspection.eventCount, 3)
  assert.deepEqual(inspection.cycles, [])
})

test('idempotency keys fail closed on divergent content', async () => {
  const value = 'x\n'
  const root = await workspace([node('same-key', 'artifact:a', 'artifact', 'a.txt', hash(value))], { 'a.txt': value, 'b.txt': value })
  await ingestLineage({ workspaceRoot: root, ledgerDir: 'ledger', eventsPath: 'events.jsonl' })
  await writeFile(join(root, 'diverged.jsonl'), `${JSON.stringify(node('same-key', 'artifact:b', 'artifact', 'b.txt', hash(value)))}\n`)
  await assert.rejects(ingestLineage({ workspaceRoot: root, ledgerDir: 'ledger', eventsPath: 'diverged.jsonl' }), /diverged/)
})

test('supports same-type supersedes and rejects cross-type supersedes', async () => {
  const value = 'x\n'
  const valid = [
    node('old-node', 'artifact:old', 'artifact', 'old.txt', hash(value)),
    node('new-node', 'artifact:new', 'artifact', 'new.txt', hash(value)),
    edge('supersedes-edge', 'edge:supersedes', 'supersedes', 'artifact:new', 'artifact:old')
  ]
  const root = await workspace(valid, { 'old.txt': value, 'new.txt': value, 'report.txt': value })
  const result = await ingestLineage({ workspaceRoot: root, ledgerDir: 'ledger', eventsPath: 'events.jsonl' })
  assert.equal(result.healthy, true)
  await writeFile(join(root, 'invalid.jsonl'), `${JSON.stringify(node('report-node', 'report:new', 'report', 'report.txt', hash(value)))}\n${JSON.stringify(edge('invalid-supersedes', 'edge:invalid', 'supersedes', 'report:new', 'artifact:old'))}\n`)
  await assert.rejects(ingestLineage({ workspaceRoot: root, ledgerDir: 'ledger', eventsPath: 'invalid.jsonl' }), /SUPERSEDES_TYPE_MISMATCH/)
})

test('rejects raw claims, chat content, secrets, traversal and symlinks', async () => {
  const raw = node('fact-v1', 'fact:a', 'fact', 'fact.json', hash('{}\n'))
  raw.node.claim = 'invented'
  assert.throws(() => normalizeEvent(raw), /raw-content/)
  const secret = node('fact-v1', 'fact:a', 'fact', 'fact.json', hash('{}\n'))
  secret.apiToken = 'do-not-store'
  assert.throws(() => normalizeEvent(secret), /secret-bearing/)

  const root = await workspace([node('fact-v1', 'fact:a', 'fact', 'fact.json', hash('{}\n'))], { 'fact.json': '{}\n' })
  await assert.rejects(ingestLineage({ workspaceRoot: root, ledgerDir: '../ledger', eventsPath: 'events.jsonl' }), /must not escape/)
  const outside = await mkdtemp(join(tmpdir(), 'dsh-lineage-outside-'))
  await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(ingestLineage({ workspaceRoot: root, ledgerDir: 'linked/ledger', eventsPath: 'events.jsonl' }), /symlink/)
})
