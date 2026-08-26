import {
  GuidanceError,
  SOURCE_PATH,
  VERSION,
  checkProject,
  findInitializationRoot,
  findProjectRoot,
  initProject,
  planProject,
  syncProject,
} from "./index.mjs";

const JSON_SCHEMA_VERSION = 1;

const HELP = `agent-guidance ${VERSION}

Deterministically sync canonical coding-agent guidance.

Usage:
  agent-guidance init [--json]
  agent-guidance sync [--adopt | --force] [--dry-run] [--json]
  agent-guidance check [--json]
  agent-guidance --help
  agent-guidance --version

Commands:
  init    Create missing canonical source files without overwriting existing files.
  sync    Create or refresh generated guidance files.
  check   Exit non-zero when guidance is missing, stale, obsolete, unmanaged, or unsafe.

Options:
  --adopt    Claim unmanaged files only when their payload already matches.
  --dry-run  Plan a sync without creating, changing, or removing files.
  --force    Replace differing unmanaged regular files.
  --json     Emit a versioned machine-readable result.
  --help     Show this help.
  --version  Show the package version.
`;

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

function parseArguments(argv) {
  const helpRequested = argv.includes("--help") || argv.includes("-h");
  if (argv.length === 0) {
    return { command: "help" };
  }
  if (helpRequested) {
    const commandHelp =
      argv.length === 2 &&
      ["init", "sync", "check"].includes(argv[0]) &&
      ["--help", "-h"].includes(argv[1]);
    if (argv.length === 1 || commandHelp) return { command: "help" };
    throw new UsageError("--help cannot be combined with other options.");
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    if (argv.length !== 1) {
      throw new UsageError("--version cannot be combined with other arguments.");
    }
    return { command: "version" };
  }

  const [command, ...options] = argv;
  if (!["init", "sync", "check"].includes(command)) {
    throw new UsageError(`Unknown command: ${command}`);
  }
  const unknownOptions = options.filter(
    (option) => !["--adopt", "--dry-run", "--force", "--json"].includes(option),
  );
  if (unknownOptions.length > 0) {
    throw new UsageError(`Unknown option: ${unknownOptions[0]}`);
  }
  const duplicateOption = options.find((option, index) => options.indexOf(option) !== index);
  if (duplicateOption) {
    throw new UsageError(`Duplicate option: ${duplicateOption}`);
  }
  if (
    ["init", "check"].includes(command) &&
    options.some((option) => ["--adopt", "--force"].includes(option))
  ) {
    throw new UsageError(`${command} does not accept --adopt or --force.`);
  }
  if (["init", "check"].includes(command) && options.includes("--dry-run")) {
    throw new UsageError(`${command} does not accept --dry-run.`);
  }
  if (options.includes("--adopt") && options.includes("--force")) {
    throw new UsageError("--adopt and --force are mutually exclusive.");
  }
  return {
    command,
    dryRun: options.includes("--dry-run"),
    json: options.includes("--json"),
    takeover: options.includes("--force") ? "force" : options.includes("--adopt") ? "adopt" : "none",
  };
}

function unicodeEscape(character) {
  const codePoint = character.codePointAt(0);
  if (codePoint <= 0xffff) return `\\u${codePoint.toString(16).padStart(4, "0")}`;
  const value = codePoint - 0x10000;
  const high = 0xd800 + (value >> 10);
  const low = 0xdc00 + (value & 0x3ff);
  return `\\u${high.toString(16)}\\u${low.toString(16)}`;
}

function terminalSafeInline(value) {
  const namedEscapes = new Map([
    ["\b", "\\b"],
    ["\t", "\\t"],
    ["\n", "\\n"],
    ["\f", "\\f"],
    ["\r", "\\r"],
  ]);
  return String(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => {
    const namedEscape = namedEscapes.get(character);
    if (namedEscape) return namedEscape;
    return unicodeEscape(character);
  });
}

function jsonStringify(value) {
  return JSON.stringify(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, unicodeEscape);
}

function publicPlan(plan) {
  return plan.map((item) => ({
    action: item.action,
    path: item.relativePath,
    ...(item.reason ? { reason: item.reason } : {}),
  }));
}

function previewSyncProject(root, takeover) {
  const plan = planProject(root, { takeover });
  return {
    ok: plan.every((item) => !["conflict", "unsafe"].includes(item.action)),
    plan,
    root,
  };
}

function writeJson(write, value) {
  write(jsonStringify(value));
}

function requestedCommand(argv) {
  return ["init", "sync", "check"].includes(argv[0]) ? argv[0] : null;
}

function itemDescription(item) {
  const action = terminalSafeInline(item.action);
  const relativePath = terminalSafeInline(item.relativePath);
  const reason = terminalSafeInline(item.reason ?? "");
  switch (item.action) {
    case "create":
      return `missing: ${relativePath}`;
    case "update":
      return `stale: ${relativePath}`;
    case "adopt":
      return `adopt: ${relativePath}`;
    case "replace":
      return `replace: ${relativePath}`;
    case "delete":
      return `obsolete: ${relativePath}`;
    case "conflict":
      return `unmanaged: ${relativePath} (${reason})`;
    case "unsafe":
      return `unsafe: ${relativePath} (${reason})`;
    default:
      return `${action}: ${relativePath}`;
  }
}

function writeLines(write, heading, items) {
  write(heading);
  for (const item of items) write(`- ${itemDescription(item)}`);
}

export function runCli(
  argv = process.argv.slice(2),
  {
    cwd = process.cwd(),
    writeError = (message) => console.error(message),
    writeOutput = (message) => console.log(message),
  } = {},
) {
  const jsonRequested = argv.includes("--json");
  try {
    const parsed = parseArguments(argv);
    if (parsed.command === "help") {
      writeOutput(HELP.trimEnd());
      return 0;
    }
    if (parsed.command === "version") {
      writeOutput(VERSION);
      return 0;
    }

    if (parsed.command === "init") {
      const root = findInitializationRoot(cwd);
      const result = initProject(root);
      if (parsed.json) {
        writeJson(writeOutput, {
          schemaVersion: JSON_SCHEMA_VERSION,
          command: "init",
          ok: true,
          status: result.createdAny ? "initialized" : "unchanged",
          root: result.root,
          createdPaths: result.createdPaths,
          existingPaths: result.existingPaths,
        });
        return 0;
      }
      if (result.createdPaths.length === 0) {
        writeOutput(`Agent guidance is already initialized in .agents/.`);
        return 0;
      }
      writeOutput("Initialized agent guidance.");
      for (const relativePath of result.createdPaths) {
        writeOutput(`- created: ${terminalSafeInline(relativePath)}`);
      }
      writeOutput(`Edit ${SOURCE_PATH}, then run agent-guidance sync.`);
      return 0;
    }

    const root = findProjectRoot(cwd);
    if (parsed.command === "check") {
      const result = checkProject(root);
      if (parsed.json) {
        writeJson(writeOutput, {
          schemaVersion: JSON_SCHEMA_VERSION,
          command: "check",
          ok: result.ok,
          status: result.ok ? "in-sync" : "out-of-sync",
          root: result.root,
          plan: publicPlan(result.plan),
        });
        return result.ok ? 0 : 1;
      }
      if (result.ok) {
        writeOutput("Agent guidance is in sync.");
        return 0;
      }
      writeLines(
        writeError,
        "Agent guidance is out of sync.",
        result.plan.filter((item) => item.action !== "unchanged"),
      );
      return 1;
    }

    const result = parsed.dryRun
      ? previewSyncProject(root, parsed.takeover)
      : syncProject(root, { takeover: parsed.takeover });
    const changed = result.plan.filter((item) => item.action !== "unchanged");
    if (parsed.json) {
      writeJson(writeOutput, {
        schemaVersion: JSON_SCHEMA_VERSION,
        command: "sync",
        ok: result.ok,
        status: !result.ok
          ? "blocked"
          : changed.length === 0
            ? "unchanged"
            : parsed.dryRun
              ? "changes-planned"
              : "synced",
        root: result.root,
        dryRun: parsed.dryRun,
        takeover: parsed.takeover,
        plan: publicPlan(result.plan),
      });
      return result.ok ? 0 : 1;
    }
    if (!result.ok) {
      writeLines(
        writeError,
        "Agent guidance was not changed because one or more targets are unmanaged or unsafe.",
        result.plan.filter((item) => ["conflict", "unsafe"].includes(item.action)),
      );
      return 1;
    }
    if (changed.length === 0) {
      writeOutput("Agent guidance is already in sync.");
      return 0;
    }
    writeLines(
      writeOutput,
      parsed.dryRun
        ? "Dry run: agent guidance would be synced; no files were changed."
        : "Synced agent guidance.",
      changed,
    );
    return 0;
  } catch (error) {
    const message =
      error instanceof GuidanceError || error instanceof Error ? error.message : String(error);
    if (jsonRequested) {
      writeJson(writeError, {
        schemaVersion: JSON_SCHEMA_VERSION,
        command: requestedCommand(argv),
        ok: false,
        status: "error",
        error: {
          type:
            error instanceof UsageError
              ? "usage"
              : error instanceof GuidanceError
                ? "guidance"
                : "internal",
          message,
        },
      });
      return error instanceof UsageError ? 2 : 1;
    }
    if (error instanceof UsageError) {
      writeError(`${terminalSafeInline(error.message)}\n\n${HELP.trimEnd()}`);
      return 2;
    }
    writeError(terminalSafeInline(message));
    return 1;
  }
}
