# agent-guidance-sync

Deterministically sync one canonical set of coding-agent guidance to
`AGENTS.md`, `CLAUDE.md`, Cursor rules, and GitHub Copilot instructions.

This project is a local, one-way guidance compiler. It does not generate
guidance with AI and it is not an MCP server.

## Status

The initial milestone supports repository-wide guidance from
`.agents/guide.md`. Scoped rules, configuration, and `init` are planned but are
not part of this slice yet.

## Usage

Create `.agents/guide.md`, then run:

```sh
npx @martinmqz/agent-guidance-sync sync
npx @martinmqz/agent-guidance-sync check
```

The package installs the `agent-guidance` executable and generates:

| Agent | Generated target |
| --- | --- |
| Codex and compatible agents | `AGENTS.md` |
| Claude Code | `CLAUDE.md` |
| Cursor | `.cursor/rules/agent-guidance.mdc` |
| GitHub Copilot | `.github/copilot-instructions.md` |

Run the command from the repository root or any descendant directory. The
nearest ancestor containing `.agents/guide.md` is used. Discovery never climbs
past a nested Git repository boundary.

## Existing files

Generated files carry an exact, target-specific ownership marker. By default,
`sync` updates only missing or already-owned files and refuses to make any
changes when an unmanaged target exists.

- `agent-guidance sync --adopt` claims an unmanaged file only when its payload
  already matches the generated payload exactly.
- `agent-guidance sync --force` replaces differing unmanaged regular files.
- Symlinks and non-regular targets detected during planning, staging, or commit
  are not followed, removed, or replaced, including in force mode. Missing
  targets use no-clobber publication so a late-created path cannot be replaced.

All output is staged and flushed before publication. Existing files use a
same-directory atomic rename; missing files use an atomic hard-link publication.
The multi-file commit is not transactional if the operating system fails during
publication, and the tool does not claim protection from a hostile process that
mutates an existing destination inside the final filesystem-syscall window.
After any failed sync, rerun `check` before retrying. `check` uses the same plan
as `sync` and never changes files.

## Development

```sh
npm test
```

The implementation has no runtime dependencies and requires Node.js 20 or
newer.

## License

MIT
