import {
  GuidanceError,
  SOURCE_PATH,
  VERSION,
  checkProject,
  findInitializationRoot,
  findProjectRoot,
  initProject,
  syncProject,
} from "./index.mjs";

const HELP = `agent-guidance ${VERSION}

Deterministically sync canonical coding-agent guidance.

Usage:
  agent-guidance init
  agent-guidance sync [--adopt | --force]
  agent-guidance check
  agent-guidance --help
  agent-guidance --version

Commands:
  init    Create missing canonical source files without overwriting existing files.
  sync    Create or refresh generated guidance files.
  check   Exit non-zero when guidance is missing, stale, obsolete, unmanaged, or unsafe.

Options:
  --adopt    Claim unmanaged files only when their payload already matches.
  --force    Replace differing unmanaged regular files.
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
      argv.length === 2 && ["init", "sync", "check"].includes(argv[0]) && ["--help", "-h"].includes(argv[1]);
    if (argv.length === 1 || commandHelp) return { command: "help" };
    throw new UsageError("--help cannot be combined with other options.");
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    if (argv.length !== 1) throw new UsageError("--version cannot be combined with other arguments.");
    return { command: "version" };
  }

  const [command, ...options] = argv;
  if (!["init", "sync", "check"].includes(command)) {
    throw new UsageError(`Unknown command: ${command}`);
  }
  const unknownOptions = options.filter((option) => !["--adopt", "--force"].includes(option));
  if (unknownOptions.length > 0) {
    throw new UsageError(`Unknown option: ${unknownOptions[0]}`);
  }
  const duplicateOption = options.find((option, index) => options.indexOf(option) !== index);
  if (duplicateOption) {
    throw new UsageError(`Duplicate option: ${duplicateOption}`);
  }
  if (["init", "check"].includes(command) && options.length > 0) {
    throw new UsageError(`${command} does not accept --adopt or --force.`);
  }
  if (options.includes("--adopt") && options.includes("--force")) {
    throw new UsageError("--adopt and --force are mutually exclusive.");
  }
  return {
    command,
    takeover: options.includes("--force") ? "force" : options.includes("--adopt") ? "adopt" : "none",
  };
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
    const codePoint = character.codePointAt(0);
    return codePoint <= 0xffff
      ? `\\u${codePoint.toString(16).padStart(4, "0")}`
      : `\\u{${codePoint.toString(16)}}`;
  });
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

    const result = syncProject(root, { takeover: parsed.takeover });
    if (!result.ok) {
      writeLines(
        writeError,
        "Agent guidance was not changed because one or more targets are unmanaged or unsafe.",
        result.plan.filter((item) => ["conflict", "unsafe"].includes(item.action)),
      );
      return 1;
    }
    if (result.changed.length === 0) {
      writeOutput("Agent guidance is already in sync.");
      return 0;
    }
    writeLines(writeOutput, "Synced agent guidance.", result.changed);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      writeError(`${terminalSafeInline(error.message)}\n\n${HELP.trimEnd()}`);
      return 2;
    }
    const message =
      error instanceof GuidanceError || error instanceof Error ? error.message : String(error);
    writeError(terminalSafeInline(message));
    return 1;
  }
}
