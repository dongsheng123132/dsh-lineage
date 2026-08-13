#!/usr/bin/env node
import { ingestLineage, inspectLineage, queryLineage, verifyLineage } from '../lib/lineage.mjs'

function usage() {
  return 'Usage: dsh-lineage <inspect|ingest|query|verify> --root <dir> --ledger <dir> [--events <jsonl>] [--node <id> --direction <upstream|downstream|both>] [--artifact-dir <dir>]'
}

function parse(argv) {
  const command = argv.shift()
  const allowed = new Set(['--root', '--ledger', '--events', '--node', '--direction', '--artifact-dir'])
  const values = {}
  while (argv.length) {
    const flag = argv.shift()
    if (!allowed.has(flag) || argv.length === 0) throw new Error(usage())
    values[flag.slice(2)] = argv.shift()
  }
  if (!['inspect', 'ingest', 'query', 'verify'].includes(command) || !values.root || !values.ledger) throw new Error(usage())
  if (command === 'ingest' && !values.events) throw new Error(usage())
  if (['query', 'verify'].includes(command) && (!values.node || !values.direction)) throw new Error(usage())
  if (command === 'verify' && !values['artifact-dir']) throw new Error(usage())
  return {
    command,
    workspaceRoot: values.root,
    ledgerDir: values.ledger,
    eventsPath: values.events,
    nodeId: values.node,
    direction: values.direction,
    artifactDir: values['artifact-dir']
  }
}

try {
  const options = parse(process.argv.slice(2))
  const result = options.command === 'inspect'
    ? await inspectLineage(options)
    : options.command === 'ingest'
      ? await ingestLineage(options)
      : options.command === 'query'
        ? await queryLineage(options)
        : await verifyLineage(options)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (options.command === 'verify' && !result.passed) process.exitCode = 2
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code ?? 'ERROR', error: error instanceof Error ? error.message : 'unknown error' })}\n`)
  process.exitCode = 1
}
