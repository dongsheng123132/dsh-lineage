import { defineTool } from '@deepseek-ai/dsh-tools'
import { ingestLineage, inspectLineage, queryLineage, verifyLineage } from './lib/lineage.mjs'

export const name = 'dsh-lineage'
export const inject = ['tools']

function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function base(config, args) {
  return { workspaceRoot: config.workspaceRoot ?? process.cwd(), ledgerDir: args.ledgerDir }
}

export function createDefinitions(_ctx, config = {}) {
  return [
    defineTool({
      name: 'dsh_lineage_inspect',
      description: 'Inspect an append-only lineage ledger and return node/edge counts, ledger fingerprint, cycles, dangling references and missing or stale content evidence. Never returns referenced object contents.',
      parameters: { ledgerDir: { type: 'string', required: true, description: 'Append-only ledger directory relative to workspaceRoot.' } },
      output: { schema: { type: 'json' }, render: renderJson },
      execute(args) { return inspectLineage(base(config, args)) }
    }),
    defineTool({
      name: 'dsh_lineage_ingest',
      description: 'Incrementally ingest explicit JSONL node/edge events. Each event needs an idempotency key; immutable event files are atomically linked into the ledger, replay-safe and read-back verified. Cycles are rejected before writes.',
      parameters: {
        ledgerDir: { type: 'string', required: true, description: 'Append-only ledger directory relative to workspaceRoot.' },
        eventsPath: { type: 'string', required: true, description: 'JSONL events path relative to workspaceRoot.' }
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute(args) { return ingestLineage({ ...base(config, args), eventsPath: args.eventsPath }) }
    }),
    defineTool({
      name: 'dsh_lineage_query',
      description: 'Query deterministic upstream, downstream or bidirectional closure from one node ID. Upstream follows derived-from/observed-by/produced-by/supersedes edges; downstream follows their reverse.',
      parameters: {
        ledgerDir: { type: 'string', required: true, description: 'Append-only ledger directory relative to workspaceRoot.' },
        nodeId: { type: 'string', required: true, description: 'Starting node ID.' },
        direction: { type: 'string', required: true, description: 'upstream, downstream or both.' }
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute(args) { return queryLineage({ ...base(config, args), nodeId: args.nodeId, direction: args.direction }) }
    }),
    defineTool({
      name: 'dsh_lineage_verify',
      description: 'Verify a node closure for resolvable files, SHA-256 freshness, dangling nodes and DAG integrity. Writes only a content-addressed JSON report inside explicit artifactDir and verifies it by read-back.',
      parameters: {
        ledgerDir: { type: 'string', required: true, description: 'Append-only ledger directory relative to workspaceRoot.' },
        nodeId: { type: 'string', required: true, description: 'Starting node ID.' },
        direction: { type: 'string', required: true, description: 'upstream, downstream or both.' },
        artifactDir: { type: 'string', required: true, description: 'Only report directory that may be written, relative to workspaceRoot.' }
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute(args) { return verifyLineage({ ...base(config, args), nodeId: args.nodeId, direction: args.direction, artifactDir: args.artifactDir }) }
    })
  ]
}

export function apply(ctx, config = {}) {
  for (const definition of createDefinitions(ctx, config)) ctx.tools.register(definition)
}
