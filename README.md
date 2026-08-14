# dsh-lineage

[![CI](https://github.com/dongsheng123132/dsh-lineage/actions/workflows/check.yml/badge.svg)](https://github.com/dongsheng123132/dsh-lineage/actions/workflows/check.yml)
[![MIT license](https://img.shields.io/github/license/dongsheng123132/dsh-lineage)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-%E2%89%A522-339933?logo=nodedotjs&logoColor=white)](package.json)
[![Awesome DSH Plugins](https://img.shields.io/badge/Awesome_DSH-verified_lab-0969da)](https://github.com/dongsheng123132/awesome-dsh-plugins#2origin-plugin-lab)

Content-addressed data and action lineage evidence for [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness).

The DSH ecosystem already has a security-audit plugin that reports plugin provenance. `dsh-lineage` addresses a different gap: it builds a local, verifiable object graph for artifacts, verified-fact records, actions, and reports. It never stores chat transcripts or factual prose; a node is only a typed ID plus an explicit workspace-relative object reference and expected SHA-256.

## Graph model

Node types:

- `artifact`
- `fact`
- `action`
- `report`

Edge types point from the dependent object toward its provenance:

- `derived-from`
- `observed-by`
- `produced-by`
- `supersedes`

Every node reference is dereferenced inside `workspaceRoot` and hashed. The verifier distinguishes:

- `verified`: the object exists and matches its expected hash;
- `missing`: the reference cannot be resolved;
- `stale`: the object exists but its current hash differs;
- dangling graph references, invalid relation types, and cycles.

No missing or stale object is silently promoted into a fact.

## Append-only ledger

Input is explicit JSONL. Each event has an `idempotencyKey` and either `put-node` or `put-edge`. The key maps to one immutable event file in `ledgerDir`:

1. validate the complete hypothetical graph before writing;
2. write a temporary file inside the explicit ledger directory;
3. read it back;
4. atomically hard-link it into its final immutable slot;
5. read the published file back and verify SHA-256.

Replaying the same key and event is safe. Reusing a key with different content fails closed. Event files are never updated; a new object revision gets a new node ID and a `supersedes` edge.

## Safety model

- All ledger, JSONL, object and report paths are workspace-relative; traversal and symlink components are rejected.
- Writes occur only inside explicit `ledgerDir` or `artifactDir`.
- Event schemas allow only structural IDs, types, paths and hashes. Keys for claims, chat, prompts, messages, raw content, text, credentials, tokens, cookies and authorization are rejected.
- Referenced object bytes are hashed but never copied into the ledger or reports.
- Ingest rejects self-edges, graph cycles and invalid producer/observer/supersedes type constraints before publication.
- Closure reports are content addressed and read-back verified.

Run this over evidence objects you created or were authorized to inspect. A hash proves identity, not truth; `dsh-lineage` reports what is present, missing or changed and does not invent assertions.

## Install in DSH

```bash
dsh plugin --profile lineage add github:dongsheng123132/dsh-lineage
```

Registered tools:

- `dsh_lineage_inspect`
- `dsh_lineage_ingest`
- `dsh_lineage_query`
- `dsh_lineage_verify`

## CLI

```bash
dsh-lineage ingest --root /workspace --ledger ledger --events lineage.events.jsonl
dsh-lineage inspect --root /workspace --ledger ledger
dsh-lineage query --root /workspace --ledger ledger --node report:proof --direction upstream
dsh-lineage verify --root /workspace --ledger ledger --node report:proof --direction upstream --artifact-dir artifacts
```

`query` supports `upstream`, `downstream`, and `both`. `verify` exits `0` for a fully verified closure, `2` when a report is written but evidence is missing/stale/invalid, and `1` for an operational or schema error.

## Example

```bash
node bin/dsh-lineage.mjs ingest --root . --ledger ledger --events examples/lineage.events.jsonl
node bin/dsh-lineage.mjs verify --root . --ledger ledger --node fact:normalized-v1 --direction both --artifact-dir artifacts
```

See [`examples/lineage.events.jsonl`](examples/lineage.events.jsonl).

## Develop

```bash
npm test
npm run check
npm run smoke:plugin
```

Requires Node.js 22+. There are no runtime dependencies or install lifecycle scripts beyond the optional DSH tools SDK peer.

## License

MIT
