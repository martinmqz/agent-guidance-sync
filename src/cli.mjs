import {
  GuidanceError,
  VERSION,
  checkProject,
  findProjectRoot,
  syncProject,
} from "./index.mjs";

const HELP = `agent-guidance ${VERSION}

Deterministically sync canonical coding-agent guidance.

Usage:
  agent-guidance sync [--adopt | --force]
  agent-guidance check
  agent-guidance --help
  agent-guidance --version

Commands:
  sync    Create or refresh generated guidance files.
  check   Exit non-zero when guidance is missing, stale, unmanaged, or unsafe.

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
      argv.length === 2 && ["sync", "check"].includes(argv[0]) && ["--help", "-h"].includes(argv[1]);
    if (argv.length === 1 || commandHelp) return { command: "help" };
    throw new UsageError("--help cannot be combined with other options.");
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    if (argv.length !== 1) throw new UsageError("--version cannot be combined with other arguments.");
    return { command: "version" };
  }

  const [command, ...options] = argv;
  if (!["sync", "check"].includes(command)) {
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
  if (command === "check" && options.length > 0) {
    throw new UsageError("check does not accept --adopt or --force.");
  }
  if (options.includes("--adopt") && options.includes("--force")) {
    throw new UsageError("--adopt and --force are mutually exclusive.");
  }
  return {
    command,
    takeover: options.includes("--force") ? "force" : options.includes("--adopt") ? "adopt" : "none",
  };
}

function itemDescription(item) {
  switch (item.action) {
    case "create":
      return `missing: ${item.relativePath}`;
    case "update":
      return `stale: ${item.relativePath}`;
    case "adopt":
      return `adopt: ${item.relativePath}`;
    case "replace":
      return `replace: ${item.relativePath}`;
    case "conflict":
      return `unmanaged: ${item.relativePath} (${item.reason})`;
    case "unsafe":
      return `unsafe: ${item.relativePath} (${item.reason})`;
    default:
      return `${item.action}: ${item.relativePath}`;
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
      writeError(`${error.message}\n\n${HELP.trimEnd()}`);
      return 2;
    }
    writeError(error instanceof GuidanceError || error instanceof Error ? error.message : String(error));
    return 1;
  }
}
