import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

const EVENT_VERSION = 1
const MAX_JSONL_BYTES = 16 * 1024 * 1024
const MAX_EVENT_BYTES = 256 * 1024
const NODE_TYPES = new Set(['artifact', 'fact', 'action', 'report'])
const EDGE_TYPES = new Set(['derived-from', 'observed-by', 'produced-by', 'supersedes'])
const SENSITIVE = /(secret|token|password|authorization|cookie|api[-_]?key|credential|chat|prompt|message|content|text|claim)/i

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
  return value
}

function jsonBytes(value) {
  return `${JSON.stringify(stable(value), null, 2)}\n`
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (SENSITIVE.test(key)) throw new Error(`${label}.${key} is a forbidden raw-content or secret-bearing field`)
    if (!allowed.includes(key)) throw new Error(`${label}.${key} is not allowed`)
  }
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
}

function identifier(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._@/+:-]{0,191}$/.test(value)) throw new Error(`${label} must be a public safe identifier of at most 192 characters`)
  return value
}

function relativePath(value, label) {
  if (typeof value !== 'string' || value.trim() === '' || isAbsolute(value)) throw new Error(`${label} must be a non-empty path relative to workspaceRoot`)
  return value
}

function hashValue(value, label) {
  if (!/^[a-f0-9]{64}$/.test(value ?? '')) throw new Error(`${label} must be 64 lowercase hex characters`)
  return value
}

function inside(root, target) {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

async function rootPath(value) {
  return realpath(resolve(value ?? process.cwd()))
}

async function safeExisting(root, value, label, kind = 'file') {
  const candidate = resolve(root, relativePath(value, label))
  if (!inside(root, candidate)) throw new Error(`${label} must not escape workspaceRoot`)
  let current = root
  const components = relative(root, candidate).split(sep).filter(Boolean)
  for (let index = 0; index < components.length; index += 1) {
    const next = join(current, components[index])
    const stat = await lstat(next)
    if (stat.isSymbolicLink()) throw new Error(`${label} contains a symlink component`)
    if (index < components.length - 1 && !stat.isDirectory()) throw new Error(`${label} contains a non-directory component`)
    current = await realpath(next)
    if (!inside(root, current)) throw new Error(`${label} resolves outside workspaceRoot`)
  }
  const stat = await lstat(current)
  if ((kind === 'file' && !stat.isFile()) || (kind === 'directory' && !stat.isDirectory())) throw new Error(`${label} must resolve to a regular ${kind}`)
  return current
}

async function ensureDirectory(root, value, label) {
  const target = resolve(root, relativePath(value, label))
  if (!inside(root, target)) throw new Error(`${label} must not escape workspaceRoot`)
  let current = root
  for (const component of relative(root, target).split(sep).filter(Boolean)) {
    const candidate = join(current, component)
    try {
      const stat = await lstat(candidate)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} contains a symlink or non-directory component`)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      await mkdir(candidate)
    }
    current = await realpath(candidate)
    if (!inside(root, current)) throw new Error(`${label} resolves outside workspaceRoot`)
  }
  return current
}

function normalizeEvent(raw, label = 'event') {
  assertObject(raw, label)
  exactKeys(raw, ['eventVersion', 'idempotencyKey', 'op', 'node', 'edge'], label)
  if (raw.eventVersion !== EVENT_VERSION) throw new Error(`${label}.eventVersion must be ${EVENT_VERSION}`)
  const event = { eventVersion: EVENT_VERSION, idempotencyKey: identifier(raw.idempotencyKey, `${label}.idempotencyKey`), op: raw.op }
  if (raw.op === 'put-node') {
    assertObject(raw.node, `${label}.node`)
    exactKeys(raw.node, ['id', 'type', 'ref'], `${label}.node`)
    if (!NODE_TYPES.has(raw.node.type)) throw new Error(`${label}.node.type must be artifact, fact, action or report`)
    assertObject(raw.node.ref, `${label}.node.ref`)
    exactKeys(raw.node.ref, ['path', 'sha256'], `${label}.node.ref`)
    event.node = {
      id: identifier(raw.node.id, `${label}.node.id`),
      type: raw.node.type,
      ref: { path: relativePath(raw.node.ref.path, `${label}.node.ref.path`), sha256: hashValue(raw.node.ref.sha256, `${label}.node.ref.sha256`) }
    }
  } else if (raw.op === 'put-edge') {
    assertObject(raw.edge, `${label}.edge`)
    exactKeys(raw.edge, ['id', 'type', 'from', 'to'], `${label}.edge`)
    if (!EDGE_TYPES.has(raw.edge.type)) throw new Error(`${label}.edge.type must be derived-from, observed-by, produced-by or supersedes`)
    event.edge = {
      id: identifier(raw.edge.id, `${label}.edge.id`),
      type: raw.edge.type,
      from: identifier(raw.edge.from, `${label}.edge.from`),
      to: identifier(raw.edge.to, `${label}.edge.to`)
    }
    if (event.edge.from === event.edge.to) throw new Error(`${label}.edge must not be a self-edge`)
  } else throw new Error(`${label}.op must be put-node or put-edge`)
  return event
}

function assemble(events) {
  const nodes = new Map()
  const edges = new Map()
  for (const event of events) {
    if (event.op === 'put-node') {
      const existing = nodes.get(event.node.id)
      if (existing && jsonBytes(existing) !== jsonBytes(event.node)) throw new Error(`node ${event.node.id} has divergent immutable definitions`)
      nodes.set(event.node.id, event.node)
    } else {
      const existing = edges.get(event.edge.id)
      if (existing && jsonBytes(existing) !== jsonBytes(event.edge)) throw new Error(`edge ${event.edge.id} has divergent immutable definitions`)
      edges.set(event.edge.id, event.edge)
    }
  }
  return { nodes, edges }
}

function findCycles(graph) {
  const outgoing = new Map()
  for (const id of graph.nodes.keys()) outgoing.set(id, [])
  for (const edge of graph.edges.values()) {
    if (graph.nodes.has(edge.from) && graph.nodes.has(edge.to)) outgoing.get(edge.from).push(edge.to)
  }
  for (const values of outgoing.values()) values.sort()
  const state = new Map()
  const stack = []
  const cycles = []
  function visit(id) {
    state.set(id, 1)
    stack.push(id)
    for (const next of outgoing.get(id) ?? []) {
      if (!state.has(next)) visit(next)
      else if (state.get(next) === 1) cycles.push([...stack.slice(stack.indexOf(next)), next])
    }
    stack.pop()
    state.set(id, 2)
  }
  for (const id of [...graph.nodes.keys()].sort()) if (!state.has(id)) visit(id)
  return cycles
}

function validateRelations(graph) {
  const errors = []
  for (const edge of graph.edges.values()) {
    const from = graph.nodes.get(edge.from)
    const to = graph.nodes.get(edge.to)
    if (!from || !to) continue
    if (edge.type === 'supersedes' && from.type !== to.type) errors.push({ edgeId: edge.id, code: 'SUPERSEDES_TYPE_MISMATCH' })
    if (edge.type === 'produced-by' && to.type !== 'action') errors.push({ edgeId: edge.id, code: 'PRODUCER_NOT_ACTION' })
    if (edge.type === 'observed-by' && !['action', 'report'].includes(to.type)) errors.push({ edgeId: edge.id, code: 'OBSERVER_NOT_ACTION_OR_REPORT' })
  }
  return errors
}

async function loadLedger(root, ledgerDir, create = false) {
  let directory
  if (create) directory = await ensureDirectory(root, ledgerDir, 'ledgerDir')
  else directory = await safeExisting(root, ledgerDir, 'ledgerDir', 'directory')
  const names = (await readdir(directory)).filter(name => name.endsWith('.event.json')).sort()
  const events = []
  const slots = new Map()
  const eventEvidence = []
  for (const name of names) {
    const path = join(directory, name)
    const stat = await lstat(path)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`ledger event ${name} must be a regular file`)
    if (stat.size > MAX_EVENT_BYTES) throw new Error(`ledger event ${name} exceeds ${MAX_EVENT_BYTES} bytes`)
    const bytes = await readFile(path)
    let raw
    try { raw = JSON.parse(bytes.toString('utf8')) } catch { throw new Error(`ledger event ${name} is invalid JSON`) }
    const event = normalizeEvent(raw, `ledger event ${name}`)
    const expectedName = `${sha256(event.idempotencyKey)}.event.json`
    if (name !== expectedName) throw new Error(`ledger event ${name} does not match its idempotency key`)
    events.push(event)
    slots.set(event.idempotencyKey, { event, content: jsonBytes(event), path })
    eventEvidence.push({ idempotencyKeySha256: sha256(event.idempotencyKey), eventSha256: sha256(bytes), bytes: bytes.length })
  }
  const graph = assemble(events)
  return { directory, events, slots, graph, eventEvidence, fingerprint: sha256(jsonBytes(eventEvidence)) }
}

async function nodeObservation(root, node) {
  const observation = { id: node.id, type: node.type, path: node.ref.path, expectedSha256: node.ref.sha256, status: 'missing', actualSha256: null, bytes: null }
  try {
    const actual = await safeExisting(root, node.ref.path, `node ${node.id} ref`)
    const bytes = await readFile(actual)
    observation.actualSha256 = sha256(bytes)
    observation.bytes = bytes.length
    observation.status = observation.actualSha256 === node.ref.sha256 ? 'verified' : 'stale'
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error
  }
  return observation
}

async function assess(root, ledger) {
  const observations = await Promise.all([...ledger.graph.nodes.values()].sort((a, b) => a.id.localeCompare(b.id)).map(node => nodeObservation(root, node)))
  const dangling = [...ledger.graph.edges.values()].filter(edge => !ledger.graph.nodes.has(edge.from) || !ledger.graph.nodes.has(edge.to)).map(edge => ({ edgeId: edge.id, missing: [!ledger.graph.nodes.has(edge.from) ? edge.from : null, !ledger.graph.nodes.has(edge.to) ? edge.to : null].filter(Boolean) }))
  const cycles = findCycles(ledger.graph)
  const relationErrors = validateRelations(ledger.graph)
  return {
    observations,
    missing: observations.filter(item => item.status === 'missing').map(item => item.id),
    stale: observations.filter(item => item.status === 'stale').map(item => item.id),
    dangling,
    cycles,
    relationErrors,
    healthy: observations.every(item => item.status === 'verified') && dangling.length === 0 && cycles.length === 0 && relationErrors.length === 0
  }
}

export async function inspectLineage(options) {
  const root = await rootPath(options.workspaceRoot)
  const ledger = await loadLedger(root, options.ledgerDir)
  const assessment = await assess(root, ledger)
  return {
    schemaVersion: 1,
    ledgerFingerprint: ledger.fingerprint,
    eventCount: ledger.events.length,
    nodes: Object.fromEntries([...NODE_TYPES].map(type => [type, [...ledger.graph.nodes.values()].filter(node => node.type === type).length])),
    edges: Object.fromEntries([...EDGE_TYPES].map(type => [type, [...ledger.graph.edges.values()].filter(edge => edge.type === type).length])),
    missing: assessment.missing,
    stale: assessment.stale,
    dangling: assessment.dangling,
    cycles: assessment.cycles,
    relationErrors: assessment.relationErrors,
    healthy: assessment.healthy
  }
}

async function readEvents(root, eventsPath) {
  const path = await safeExisting(root, eventsPath, 'eventsPath')
  const bytes = await readFile(path)
  if (bytes.length > MAX_JSONL_BYTES) throw new Error(`eventsPath exceeds ${MAX_JSONL_BYTES} bytes`)
  const lines = bytes.toString('utf8').split(/\r?\n/).filter(line => line.trim() !== '')
  return lines.map((line, index) => {
    let raw
    try { raw = JSON.parse(line) } catch { throw new Error(`eventsPath line ${index + 1} is invalid JSON`) }
    return normalizeEvent(raw, `eventsPath line ${index + 1}`)
  })
}

async function atomicPublish(directory, fileName, content) {
  const target = join(directory, basename(fileName))
  const temporary = join(directory, `.${fileName}.${process.pid}.${randomUUID()}.tmp`)
  await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
  const tempReadBack = await readFile(temporary, 'utf8')
  if (tempReadBack !== content) throw new Error('temporary write read-back verification failed')
  let status = 'written'
  try {
    await link(temporary, target)
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const stat = await lstat(target)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('existing immutable path is not a regular file')
    if (await readFile(target, 'utf8') !== content) throw Object.assign(new Error('idempotency key diverged'), { code: 'IDEMPOTENCY_DIVERGED' })
    status = 'replayed'
  } finally {
    await unlink(temporary).catch(() => {})
  }
  const readBack = await readFile(target)
  if (sha256(readBack) !== sha256(content)) throw new Error('published file read-back verification failed')
  return { status, path: target, sha256: sha256(readBack), bytes: readBack.length, verifiedByReadBack: true }
}

export async function ingestLineage(options) {
  const root = await rootPath(options.workspaceRoot)
  const incoming = await readEvents(root, options.eventsPath)
  if (incoming.length === 0) throw new Error('eventsPath must contain at least one event')
  const ledger = await loadLedger(root, options.ledgerDir, true)
  const batchKeys = new Set()
  for (const event of incoming) {
    if (batchKeys.has(event.idempotencyKey)) throw new Error(`duplicate idempotencyKey in batch: ${event.idempotencyKey}`)
    batchKeys.add(event.idempotencyKey)
    const existing = ledger.slots.get(event.idempotencyKey)
    if (existing && existing.content !== jsonBytes(event)) throw Object.assign(new Error(`idempotency key diverged: ${event.idempotencyKey}`), { code: 'IDEMPOTENCY_DIVERGED' })
  }
  const hypothetical = assemble([...ledger.events, ...incoming])
  const cycles = findCycles(hypothetical)
  if (cycles.length) throw Object.assign(new Error(`ingest would create a cycle: ${cycles[0].join(' -> ')}`), { code: 'CYCLE' })
  const relationErrors = validateRelations(hypothetical)
  if (relationErrors.length) throw Object.assign(new Error(`ingest violates relation constraints: ${relationErrors[0].code}`), { code: relationErrors[0].code })
  const writes = []
  for (const event of incoming) {
    const content = jsonBytes(event)
    const result = await atomicPublish(ledger.directory, `${sha256(event.idempotencyKey)}.event.json`, content)
    writes.push({ idempotencyKeySha256: sha256(event.idempotencyKey), status: result.status, eventSha256: result.sha256, verifiedByReadBack: result.verifiedByReadBack })
  }
  const updated = await loadLedger(root, options.ledgerDir)
  const assessment = await assess(root, updated)
  return { ok: true, ledgerFingerprint: updated.fingerprint, eventCount: updated.events.length, writes, disclosure: { missing: assessment.missing, stale: assessment.stale, dangling: assessment.dangling }, healthy: assessment.healthy }
}

function closure(graph, nodeId, direction) {
  identifier(nodeId, 'nodeId')
  if (!['upstream', 'downstream', 'both'].includes(direction)) throw new Error('direction must be upstream, downstream or both')
  if (!graph.nodes.has(nodeId)) throw new Error(`node not found: ${nodeId}`)
  const selected = new Set([nodeId])
  const queue = [nodeId]
  const edges = [...graph.edges.values()].sort((a, b) => a.id.localeCompare(b.id))
  while (queue.length) {
    const current = queue.shift()
    for (const edge of edges) {
      let next = null
      if ((direction === 'upstream' || direction === 'both') && edge.from === current) next = edge.to
      if ((direction === 'downstream' || direction === 'both') && edge.to === current) next = edge.from
      if (next && graph.nodes.has(next) && !selected.has(next)) {
        selected.add(next)
        queue.push(next)
      }
    }
  }
  const closureEdges = edges.filter(edge =>
    (selected.has(edge.from) && selected.has(edge.to)) ||
    (selected.has(edge.from) && !graph.nodes.has(edge.to)) ||
    (selected.has(edge.to) && !graph.nodes.has(edge.from)))
  const dangling = closureEdges.flatMap(edge => [edge.from, edge.to]).filter(id => !graph.nodes.has(id))
  return { nodeIds: [...selected].sort(), edges: closureEdges, danglingNodeIds: [...new Set(dangling)].sort() }
}

export async function queryLineage(options) {
  const root = await rootPath(options.workspaceRoot)
  const ledger = await loadLedger(root, options.ledgerDir)
  const result = closure(ledger.graph, options.nodeId, options.direction)
  return { schemaVersion: 1, ledgerFingerprint: ledger.fingerprint, start: options.nodeId, direction: options.direction, ...result }
}

async function writeReport(root, artifactDir, prefix, report) {
  const directory = await ensureDirectory(root, artifactDir, 'artifactDir')
  const content = jsonBytes(report)
  const digest = sha256(content)
  const safePrefix = basename(prefix).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'lineage'
  const result = await atomicPublish(directory, `${safePrefix}-${digest.slice(0, 12)}.json`, content)
  return { path: relative(root, result.path).split(sep).join('/'), sha256: result.sha256, bytes: result.bytes, verifiedByReadBack: result.verifiedByReadBack }
}

export async function verifyLineage(options) {
  if (options.artifactDir === undefined) throw new Error('artifactDir is required')
  const root = await rootPath(options.workspaceRoot)
  const ledger = await loadLedger(root, options.ledgerDir)
  const selected = closure(ledger.graph, options.nodeId, options.direction)
  const observations = []
  for (const id of selected.nodeIds) observations.push(await nodeObservation(root, ledger.graph.nodes.get(id)))
  const cycles = findCycles(ledger.graph).filter(cycle => cycle.some(id => selected.nodeIds.includes(id)))
  const relationErrors = validateRelations(ledger.graph).filter(error => selected.edges.some(edge => edge.id === error.edgeId))
  const report = {
    schemaVersion: 1,
    kind: 'dsh.lineage-closure',
    ledgerFingerprint: ledger.fingerprint,
    start: options.nodeId,
    direction: options.direction,
    nodeIds: selected.nodeIds,
    edges: selected.edges,
    observations,
    missingNodeIds: selected.danglingNodeIds,
    missingEvidence: observations.filter(item => item.status === 'missing').map(item => item.id),
    staleEvidence: observations.filter(item => item.status === 'stale').map(item => item.id),
    cycles,
    relationErrors,
    passed: selected.danglingNodeIds.length === 0 && observations.every(item => item.status === 'verified') && cycles.length === 0 && relationErrors.length === 0
  }
  const artifact = await writeReport(root, options.artifactDir, `${options.nodeId}.${options.direction}.lineage`, report)
  return { passed: report.passed, artifact, report }
}

export { normalizeEvent }
