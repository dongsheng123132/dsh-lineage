import { readFile } from 'node:fs/promises'

const required = ['package.json', '.codex-plugin/plugin.json', '.mcp.json', 'index.js', 'lib/lineage.mjs', 'bin/dsh-lineage.mjs', 'cordis.patch.yml', 'mcp-server.mjs', 'examples/lineage.events.jsonl', 'README.md', 'README.zh-CN.md', 'SECURITY.md']
const files = Object.fromEntries(await Promise.all(required.map(async file => [file, await readFile(new URL(`../${file}`, import.meta.url), 'utf8')])))
const pkg = JSON.parse(files['package.json'])
const plugin = JSON.parse(files['.codex-plugin/plugin.json'])
if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') throw new Error('missing DSH bundle patch')
if (plugin.name !== pkg.name) throw new Error('Codex plugin name must match package name')
if (plugin.version !== pkg.version) throw new Error('Codex plugin version must match package version')
if (plugin.mcpServers !== './.mcp.json') throw new Error('Codex plugin must declare the MCP companion')
if (!files['.mcp.json'].includes('mcp-server.mjs')) throw new Error('MCP declaration is missing its server')
if (pkg.scripts?.prepare || pkg.scripts?.postinstall) throw new Error('install lifecycle scripts are forbidden')
if (/export\s+default\b/.test(files['index.js'])) throw new Error('default export is forbidden: stock DSH Loader must receive namespace inject metadata')
if (!files['cordis.patch.yml'].includes('name: dsh-lineage')) throw new Error('bundle does not mount dsh-lineage')
for (const tool of ['dsh_lineage_inspect', 'dsh_lineage_ingest', 'dsh_lineage_query', 'dsh_lineage_verify']) {
  if (!files['index.js'].includes(`name: '${tool}'`)) throw new Error(`missing tool ${tool}`)
}
for (const guard of ['idempotency key diverged', 'ingest would create a cycle', 'verifiedByReadBack', 'must not escape', 'symlink', 'append-only', 'missingEvidence', 'staleEvidence']) {
  if (!(`${files['lib/lineage.mjs']}\n${files['index.js']}`).includes(guard)) throw new Error(`guard missing: ${guard}`)
}
for (const shared of ['inspectLineageEventsJsonl', 'queryLineageEventsJsonl']) {
  if (!files['mcp-server.mjs'].includes(shared)) throw new Error(`MCP must use shared core ${shared}`)
}
console.log(JSON.stringify({ ok: true, dshBundle: pkg.dsh.bundle.patch, codexManifest: true, tools: 4, guards: 8, mcp: true, namespaceLoaderSafe: true }))
