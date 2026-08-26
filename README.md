# agent-guidance-sync

Deterministically sync one canonical set of coding-agent guidance to
`AGENTS.md`, `CLAUDE.md`, Cursor rules, and GitHub Copilot instructions.

This project is a local, one-way guidance compiler. It does not generate
guidance with AI and it is not an MCP server.

## Status

The current milestone supports safe initialization, repository-wide guidance,
always-activated rules, path-activated Cursor and GitHub Copilot rules,
non-mutating sync previews, and machine-readable output.

## Usage

Initialize the current Git repository, edit the new canonical guide, then sync
and check the generated files:

```sh
npx @martinmqz/agent-guidance-sync init
# Edit .agents/guide.md
npx @martinmqz/agent-guidance-sync sync
npx @martinmqz/agent-guidance-sync check
```

`init` reuses the nearest existing canonical source, otherwise finds the nearest
Git repository root from the current directory. When there is no Git repository,
it initializes the current directory. It creates
missing `.agents/guide.md` and `.agents/config.yaml` files, never overwrites an
existing source, and leaves output generation to an explicit `sync`.

Preview the exact sync plan without staging, publishing, or deleting files:

```sh
npx @martinmqz/agent-guidance-sync sync --dry-run
npx @martinmqz/agent-guidance-sync sync --force --dry-run
```

`--dry-run` is available only on `sync` and honors `--adopt` and `--force`.
It exits `0` when the plan is safe to apply, including when changes are pending,
and exits `1` when unmanaged or unsafe targets block the plan.

## JSON output

Pass `--json` to `init`, `sync`, or `check` to emit one JSON document. Normal
operational results are written to stdout, including out-of-sync and blocked
results that exit `1`. Usage and runtime errors are written to stderr. JSON
mode preserves the command's normal exit codes:

- `0`: the command succeeded; a dry run may still report pending changes.
- `1`: guidance is out of sync, a sync is blocked, or guidance could not be
  safely processed.
- `2`: command-line usage is invalid.

Every document has `schemaVersion: 1`, `command`, `ok`, and `status`. Command
statuses are stable within that schema:

| Command | Status values |
| --- | --- |
| `init` | `initialized`, `unchanged` |
| `sync` | `synced`, `changes-planned`, `unchanged`, `blocked` |
| `check` | `in-sync`, `out-of-sync` |
| Error | `error` |

`sync` and `check` include a deterministic `plan`. Each plan item exposes only
`action`, repository-relative `path`, and an optional `reason`; generated
contents and filesystem identity data are never serialized. Actions are
`unchanged`, `create`, `update`, `adopt`, `replace`, `delete`, `conflict`, or
`unsafe`. For example:

```json
{"schemaVersion":1,"command":"sync","ok":true,"status":"changes-planned","root":"/repo","dryRun":true,"takeover":"none","plan":[{"action":"create","path":"AGENTS.md"}]}
```

`init --json` still initializes the project. Use `sync --dry-run --json` for a
machine-readable, non-mutating sync preview.

## Canonical format

`.agents/config.yaml` uses a deliberately strict, versioned YAML subset:

```yaml
version: 1
adapters:
  agents: true
  claude: true
  cursor: true
  copilot: true
```

All adapter keys are required. Disabling an adapter removes only outputs with
an exact `agent-guidance-sync` ownership marker. The Claude adapter requires the
AGENTS adapter because `CLAUDE.md` imports `AGENTS.md`.

Rules live in lowercase kebab-case `.agents/rules/**/*.md` paths. An
always-activated rule is inlined into repository-wide outputs:

```md
---
description: Shared testing guidance
activation: always
---
# Testing

Use the repository's existing test commands.
```

A path-activated rule uses portable repository-relative globs:

```md
---
description: React component guidance
activation: path
paths:
  - "apps/web/**/*.tsx"
  - "packages/ui/**/*.tsx"
---
# React Components

Prefer observable behavior over implementation details.
```

Every rule body must begin with a level-one Markdown heading. Path-activated
rules require at least one of the Cursor or GitHub Copilot adapters because
those adapters own the scoped-rule formats.

Descriptions and paths may be unquoted, single-quoted, or JSON-style
double-quoted strings. Paths must use the indented list form shown above and
must not be absolute, negated, comma-separated, contain backslashes, `..`
segments, Windows-invalid literal characters, or segments ending in a dot or
space. Windows reserved device-name segments are also rejected. Plain values
using YAML comments, mappings, collections, anchors, aliases, tags, or block
syntax must be quoted when a literal string is intended.

Only regular files with lowercase kebab-case `.md` names are treated as rules;
other `.md` spellings are rejected so guidance cannot disappear silently.
Auxiliary regular files such as `.DS_Store`, `.gitkeep`, `README.md`, and editor
swap files are ignored. Hidden auxiliary directories are ignored without being
traversed; symlinks and non-regular entries remain unsafe. A
leading UTF-8 byte-order mark is stripped from the guide, config, and rule files
before parsing or generation.

The package installs the `agent-guidance` executable and generates:

| Agent | Generated target |
| --- | --- |
| Codex and compatible agents | `AGENTS.md` |
| Claude Code | `CLAUDE.md` |
| Cursor | `.cursor/rules/agent-guidance.mdc` |
| Cursor path rules | `.cursor/rules/agent-guidance/**/*.mdc` |
| GitHub Copilot | `.github/copilot-instructions.md` |
| Copilot path rules | `.github/instructions/agent-guidance/**/*.instructions.md` |

Run the command from the repository root or any descendant directory. The
nearest ancestor containing `.agents/guide.md` is used. Discovery never climbs
past a nested Git repository boundary.

## Existing files

Generated files carry an exact, target-specific ownership marker at an
adapter-defined header position. By default, `sync` updates only missing or
already-owned files and refuses to make any changes when an unmanaged target
exists.

- `agent-guidance sync --adopt` claims an unmanaged file only when its payload
  already matches the generated payload exactly.
- `agent-guidance sync --force` replaces differing unmanaged regular files.
- Symlinks and non-regular targets detected during planning, staging, or commit
  are not followed, removed, or replaced, including in force mode. Missing
  targets use no-clobber publication so a late-created path cannot be replaced.
- The two `agent-guidance/` scoped-rule directories are reserved generated
  namespaces. Obsolete files are removed only when their exact marker proves
  ownership; unmanaged or unsafe entries block the entire sync, including with
  `--force`.

All created or updated output is staged and flushed before publication.
Existing files use a same-directory atomic rename; missing files use an atomic
hard-link publication. The filesystem must support hard links for missing-file
publication; the CLI does not fall back to a partially visible copy that would
weaken its atomic no-clobber guarantee. Obsolete files are identity-checked
again immediately before removal. The multi-file commit is not transactional
if the operating system fails during publication, and the tool does not claim
protection from a hostile process that mutates an existing destination inside
the final filesystem-syscall window. After any failed sync, rerun `check` before
retrying. `check` uses the same plan as `sync` and never changes files.

Generated-file comparisons treat CRLF and LF checkouts as equivalent while new
output is emitted with LF. This avoids fresh Windows checkouts reporting drift
solely because Git applied `core.autocrlf`.

## Migrating older prototypes

Repositories that already have `.agents/guide.md` from an earlier release can
rerun `agent-guidance init`. It adds the missing `.agents/config.yaml` without
reading or overwriting the existing guide.

Repositories using `.agents/AGENTS.md` and Cursor-shaped canonical `.mdc` rules
must convert them to `.agents/guide.md` and the vendor-neutral rule format
above before syncing. Legacy scoped output files live outside this package's
reserved namespaces and are deliberately preserved; remove them explicitly
only after the new generated files pass `check`.

## Development

```sh
npm test
```

The implementation has no runtime dependencies and requires Node.js 20 or
newer. The synchronous library API uses process working-directory pinning to
preserve no-follow filesystem guarantees and therefore must run on the main
Node.js thread rather than inside a worker thread.

## License

MIT
