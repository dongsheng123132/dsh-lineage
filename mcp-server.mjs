#!/usr/bin/env node
import readline from 'node:readline'
import { inspectLineageEventsJsonl, queryLineageEventsJsonl } from './lib/lineage.mjs'

const MAX_LINE_BYTES = 2 * 1024 * 1024
const tools = [
  {
    name: 'lineage_events_inspect',
    description: 'Validate a bounded inline JSONL lineage graph and report structural counts, hashes, cycles, relation errors and dangling references without filesystem access.',
    inputSchema: { type: 'object', required: ['eventsJsonl'], additionalProperties: false, properties: { eventsJsonl: { type: 'string', maxLength: 1_048_576 } } }
  },
  {
    name: 'lineage_events_query',
    description: 'Query a deterministic upstream, downstream or bidirectional closure in bounded inline JSONL events without dereferencing object contents or accessing the filesystem.',
    inputSchema: {
      type: 'object', required: ['eventsJsonl', 'nodeId', 'direction'], additionalProperties: false,
      properties: {
        eventsJsonl: { type: 'string', maxLength: 1_048_576 },
        nodeId: { type: 'string', maxLength: 192 },
        direction: { type: 'string', enum: ['upstream', 'downstream', 'both'] }
      }
    }
  }
]

async function call(name, args) {
  if (name === 'lineage_events_inspect') return inspectLineageEventsJsonl(args.eventsJsonl)
  if (name === 'lineage_events_query') return queryLineageEventsJsonl(args.eventsJsonl, args.nodeId, args.direction)
  throw new Error('Unknown tool')
}

const send = value => process.stdout.write(`${JSON.stringify(value)}\n`)
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of lines) {
  if (!line.trim() || Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) continue
  let request
  try { request = JSON.parse(line) } catch { continue }
  if (request.id === undefined) continue
  try {
    if (request.method === 'initialize') {
      send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'dsh-lineage', version: '0.2.0' } } })
    } else if (request.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: request.id, result: { tools } })
    } else if (request.method === 'tools/call') {
      const result = await call(request.params?.name, request.params?.arguments ?? {})
      send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
    } else {
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })
    }
  } catch (error) {
    send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: error.message, data: { code: 'INVALID_LINEAGE' } } })
  }
}
