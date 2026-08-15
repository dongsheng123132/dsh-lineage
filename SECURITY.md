# Security policy

## Boundaries

- DSH and CLI operate only inside an explicit workspace. Ledger, event, object and report paths reject traversal and symlink escape.
- Ledger writes are append-only immutable event slots keyed by idempotency hashes. Events are validated as a complete hypothetical DAG before publication and verified after read-back.
- Events contain only typed public IDs, relative object references and SHA-256 values. Raw claims, chat, prompts, messages, content and secret-bearing fields are rejected.
- Referenced object bytes are hashed but never copied into ledger entries or reports. A matching hash proves identity, not factual truth.
- The standalone MCP server accepts only bounded inline structural events. It never dereferences objects and never reads or writes the filesystem.

Please report vulnerabilities privately through GitHub Security Advisories. Do not include credentials, chat transcripts, private object bodies or sensitive path inventories.
