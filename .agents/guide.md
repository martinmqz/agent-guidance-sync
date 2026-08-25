# Agent Guidance Sync Contributor Guide

Canonical coding-agent guidance lives in `.agents/guide.md`,
`.agents/config.yaml`, and `.agents/rules/**/*.md`. Generated agent files are
outputs; do not edit them directly.

## Development

- Keep synchronization deterministic, local, one-way, and independent of AI or
  MCP services.
- Preserve unmanaged files by default. Ownership, adoption, force, symlink, and
  atomic-write behavior are security boundaries, not convenience features.
- Keep the runtime dependency-free unless a dependency has a clear correctness
  or portability benefit.
- Keep the canonical schema vendor-neutral. Agent-specific frontmatter belongs
  only in generated adapters.
- Add focused fixtures and negative tests for every filesystem safety behavior.
- Run `npm test` and `node bin/agent-guidance.mjs check` before handoff.

## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the
repo root), reach for it before grep/find or reading files when you need to
understand or locate code:

- The `codegraph_explore` MCP tool answers most code questions with relevant
  source and call paths, including dynamic-dispatch hops text search cannot
  follow.
- The shell fallback is `codegraph explore "<symbol names or question>"`.

If there is no `.codegraph/` directory, skip CodeGraph; indexing is the user's
decision.
