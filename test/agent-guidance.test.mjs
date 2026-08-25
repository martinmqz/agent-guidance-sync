import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageMetadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const cliPath = join(packageRoot, "bin", "agent-guidance.mjs");
const fixtureRoot = join(packageRoot, "test", "fixtures", "basic");
const expectedRoot = join(fixtureRoot, "expected");
const generatedPaths = [
  "AGENTS.md",
  "CLAUDE.md",
  ".cursor/rules/agent-guidance.mdc",
  ".github/copilot-instructions.md",
];

function temporaryDirectory(t, prefix = "agent-guidance-sync-") {
  const path = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function temporaryRepo(t) {
  const root = temporaryDirectory(t);
  cpSync(join(fixtureRoot, ".agents"), join(root, ".agents"), { recursive: true });
  return root;
}

function runCli(root, ...arguments_) {
  return spawnSync(process.execPath, [cliPath, ...arguments_], {
    cwd: root,
    encoding: "utf8",
  });
}

function runCliAsync(root, ...arguments_) {
  const child = spawn(process.execPath, [cliPath, ...arguments_], { cwd: root });
  let stderr = "";
  let stdout = "";
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  const completed = new Promise((resolveCompletion, rejectCompletion) => {
    child.once("error", rejectCompletion);
    child.once("close", (status, signal) => {
      resolveCompletion({ signal, status, stderr, stdout });
    });
  });
  return { child, completed };
}

function read(root, relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function write(root, relativePath, contents) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function createSymlinkOrSkip(t, target, path, type) {
  try {
    symlinkSync(target, path, process.platform === "win32" && type === "dir" ? "junction" : type);
    return true;
  } catch (error) {
    if (
      process.platform === "win32" &&
      error &&
      typeof error === "object" &&
      ["EACCES", "ENOSYS", "EPERM"].includes(error.code)
    ) {
      t.skip(`Windows runner cannot create the required ${type} symlink: ${error.code}`);
      return false;
    }
    throw error;
  }
}

function listFiles(root, current = root) {
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(root, path));
    else files.push(relative(root, path).replaceAll("\\", "/"));
  }
  return files.sort();
}

test("generates deterministic repository-wide guidance for every supported agent", (t) => {
  const root = temporaryRepo(t);

  const initialCheck = runCli(root, "check");
  assert.equal(initialCheck.status, 1);
  for (const relativePath of generatedPaths) {
    assert.match(initialCheck.stderr, new RegExp(`missing: ${relativePath.replaceAll(".", "\\.")}`));
  }
  assert.deepEqual(listFiles(root), [".agents/guide.md"]);

  const sync = runCli(root, "sync");
  assert.equal(sync.status, 0, sync.stderr);
  assert.match(sync.stdout, /Synced agent guidance/);

  for (const relativePath of generatedPaths) {
    assert.equal(read(root, relativePath), read(expectedRoot, relativePath));
  }
  assert.deepEqual(
    listFiles(root).filter((path) => !path.startsWith(".agents/")),
    [...generatedPaths].sort(),
  );
  assert.equal(listFiles(root).some((path) => path.endsWith(".tmp")), false);

  const check = runCli(root, "check");
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /Agent guidance is in sync/);

  const secondSync = runCli(root, "sync");
  assert.equal(secondSync.status, 0, secondSync.stderr);
  assert.match(secondSync.stdout, /already in sync/);
});

test("leaves unrelated files beside generated targets untouched", (t) => {
  const root = temporaryRepo(t);
  write(root, ".cursor/rules/personal.mdc", "# Personal Cursor rule\n");
  write(root, ".github/notes.md", "# Repository notes\n");

  const sync = runCli(root, "sync");
  assert.equal(sync.status, 0, sync.stderr);
  assert.equal(read(root, ".cursor/rules/personal.mdc"), "# Personal Cursor rule\n");
  assert.equal(read(root, ".github/notes.md"), "# Repository notes\n");
  assert.equal(runCli(root, "check").status, 0);
});

test("reports missing and stale files and repairs them with the same plan", (t) => {
  const root = temporaryRepo(t);
  assert.equal(runCli(root, "sync").status, 0);

  rmSync(join(root, "CLAUDE.md"));
  writeFileSync(join(root, "AGENTS.md"), `${read(root, "AGENTS.md")}\nmanual drift\n`);

  const check = runCli(root, "check");
  assert.equal(check.status, 1);
  assert.match(check.stderr, /stale: AGENTS\.md/);
  assert.match(check.stderr, /missing: CLAUDE\.md/);

  const repair = runCli(root, "sync");
  assert.equal(repair.status, 0, repair.stderr);
  assert.match(repair.stdout, /stale: AGENTS\.md/);
  assert.match(repair.stdout, /missing: CLAUDE\.md/);
  assert.equal(read(root, "AGENTS.md"), read(expectedRoot, "AGENTS.md"));
  assert.equal(read(root, "CLAUDE.md"), read(expectedRoot, "CLAUDE.md"));
});

test("treats CRLF generated output as drift and rewrites deterministic LF", (t) => {
  const root = temporaryRepo(t);
  assert.equal(runCli(root, "sync").status, 0);
  const expected = read(root, "AGENTS.md");
  writeFileSync(join(root, "AGENTS.md"), expected.replaceAll("\n", "\r\n"));

  const check = runCli(root, "check");
  assert.equal(check.status, 1);
  assert.match(check.stderr, /stale: AGENTS\.md/);
  assert.equal(runCli(root, "sync").status, 0);
  assert.equal(read(root, "AGENTS.md"), expected);
  assert.doesNotMatch(read(root, "AGENTS.md"), /\r/);
});

test("normalizes CRLF canonical input and emits one trailing newline", (t) => {
  const root = temporaryRepo(t);
  const source = read(root, ".agents/guide.md").trimEnd().replaceAll("\n", "\r\n");
  writeFileSync(join(root, ".agents", "guide.md"), `${source}\r\n\r\n`);

  const sync = runCli(root, "sync");
  assert.equal(sync.status, 0, sync.stderr);
  for (const relativePath of generatedPaths) {
    assert.equal(read(root, relativePath), read(expectedRoot, relativePath));
  }
});

test("preserves meaningful leading indentation and trailing Markdown spaces", (t) => {
  const root = temporaryRepo(t);
  const guide = "    indented code\n\nParagraph with a hard break  \n\n";
  writeFileSync(join(root, ".agents", "guide.md"), guide);

  const sync = runCli(root, "sync");
  assert.equal(sync.status, 0, sync.stderr);
  assert.equal(
    read(root, "AGENTS.md"),
    `${read(expectedRoot, "AGENTS.md").split("\n")[0]}\n\n    indented code\n\nParagraph with a hard break  \n`,
  );
  assert.equal(runCli(root, "check").status, 0);
});

test("preserves unmanaged targets and aborts the entire default sync", (t) => {
  const root = temporaryRepo(t);
  write(root, "AGENTS.md", "# Handwritten guidance\n");

  const sync = runCli(root, "sync");
  assert.equal(sync.status, 1);
  assert.match(sync.stderr, /unmanaged: AGENTS\.md/);
  assert.equal(read(root, "AGENTS.md"), "# Handwritten guidance\n");
  for (const relativePath of generatedPaths.slice(1)) {
    assert.equal(lstatIfExists(join(root, relativePath)), null);
  }
});

test("adopts only unmanaged files whose payload already matches", (t) => {
  const matchingRoot = temporaryRepo(t);
  write(matchingRoot, "AGENTS.md", read(matchingRoot, ".agents/guide.md"));

  const adopt = runCli(matchingRoot, "sync", "--adopt");
  assert.equal(adopt.status, 0, adopt.stderr);
  assert.match(adopt.stdout, /adopt: AGENTS\.md/);
  assert.equal(read(matchingRoot, "AGENTS.md"), read(expectedRoot, "AGENTS.md"));

  const differingRoot = temporaryRepo(t);
  write(differingRoot, "AGENTS.md", "# Different guidance\n");
  const rejected = runCli(differingRoot, "sync", "--adopt");
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /content differs from the generated payload/);
  assert.equal(read(differingRoot, "AGENTS.md"), "# Different guidance\n");
  assert.equal(lstatIfExists(join(differingRoot, "CLAUDE.md")), null);
});

test("force replaces differing unmanaged regular files", (t) => {
  const root = temporaryRepo(t);
  write(root, "AGENTS.md", "# Different guidance\n");

  const sync = runCli(root, "sync", "--force");
  assert.equal(sync.status, 0, sync.stderr);
  assert.match(sync.stdout, /replace: AGENTS\.md/);
  assert.equal(read(root, "AGENTS.md"), read(expectedRoot, "AGENTS.md"));
});

test("requires the exact target-specific ownership marker", (t) => {
  const root = temporaryRepo(t);
  const wrongMarker =
    '<!-- agent-guidance-sync:generated:v1 source=".agents/guide.md" target=".github/copilot-instructions.md" -->';
  write(root, "AGENTS.md", `${wrongMarker}\n\n${read(root, ".agents/guide.md")}`);

  const sync = runCli(root, "sync");
  assert.equal(sync.status, 1);
  assert.match(sync.stderr, /unmanaged: AGENTS\.md/);
  assert.equal(read(root, "AGENTS.md").startsWith(wrongMarker), true);
});

test("does not claim a marker shown as content instead of the generated header", (t) => {
  const root = temporaryRepo(t);
  const correctMarker = read(expectedRoot, "AGENTS.md").split("\n")[0];
  const handwritten = `# Ownership marker example

\`\`\`html
${correctMarker}
\`\`\`
`;
  write(root, "AGENTS.md", handwritten);

  const sync = runCli(root, "sync");
  assert.equal(sync.status, 1);
  assert.match(sync.stderr, /unmanaged: AGENTS\.md/);
  assert.equal(read(root, "AGENTS.md"), handwritten);
  assert.equal(lstatIfExists(join(root, "CLAUDE.md")), null);
});

test("remains idempotent when canonical guidance contains an ownership marker example", (t) => {
  const root = temporaryRepo(t);
  const marker = read(expectedRoot, "AGENTS.md").split("\n")[0];
  writeFileSync(
    join(root, ".agents", "guide.md"),
    `# Marker documentation\n\nExample generated header:\n\n${marker}\n`,
  );

  const sync = runCli(root, "sync");
  assert.equal(sync.status, 0, sync.stderr);
  const check = runCli(root, "check");
  assert.equal(check.status, 0, check.stderr);
  assert.equal(read(root, "AGENTS.md").split(marker).length - 1, 2);
});

test(
  "never follows or replaces a generated file symlink, including with force",
  (t) => {
    const root = temporaryRepo(t);
    const outside = join(temporaryDirectory(t, "agent-guidance-outside-"), "sentinel.md");
    writeFileSync(outside, "outside\n");
    if (!createSymlinkOrSkip(t, outside, join(root, "AGENTS.md"), "file")) return;

    const check = runCli(root, "check");
    assert.equal(check.status, 1);
    assert.match(check.stderr, /unsafe: AGENTS\.md .*target is a symlink/);

    const sync = runCli(root, "sync", "--force");
    assert.equal(sync.status, 1);
    assert.equal(lstatSync(join(root, "AGENTS.md")).isSymbolicLink(), true);
    assert.equal(readFileSync(outside, "utf8"), "outside\n");
    assert.equal(lstatIfExists(join(root, "CLAUDE.md")), null);
  },
);

test(
  "rejects generated directories that traverse symlinks without partial writes",
  (t) => {
    const root = temporaryRepo(t);
    const outside = temporaryDirectory(t, "agent-guidance-outside-");
    writeFileSync(join(outside, "sentinel"), "outside\n");
    if (!createSymlinkOrSkip(t, outside, join(root, ".cursor"), "dir")) return;

    const sync = runCli(root, "sync", "--force");
    assert.equal(sync.status, 1);
    assert.match(sync.stderr, /generated path traverses a symlink: \.cursor/);
    assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "outside\n");
    assert.equal(lstatIfExists(join(root, "AGENTS.md")), null);
  },
);

test(
  "does not publish earlier targets when a later write cannot be staged",
  { skip: process.platform === "win32" },
  (t) => {
    const root = temporaryRepo(t);
    const unwritableDirectory = join(root, ".cursor", "rules");
    mkdirSync(unwritableDirectory, { recursive: true });
    chmodSync(unwritableDirectory, 0o555);

    let sync;
    try {
      sync = runCli(root, "sync");
    } finally {
      chmodSync(unwritableDirectory, 0o755);
    }

    assert.equal(sync.status, 1);
    assert.match(sync.stderr, /Could not stage atomic write for \.cursor\/rules\/agent-guidance\.mdc/);
    for (const relativePath of generatedPaths) {
      assert.equal(lstatIfExists(join(root, relativePath)), null);
    }
    assert.equal(listFiles(root).some((path) => path.endsWith(".tmp")), false);
  },
);

test(
  "does not replace a symlink created while a missing target is staged",
  async (t) => {
    const root = temporaryRepo(t);
    const outside = join(temporaryDirectory(t, "agent-guidance-race-"), "sentinel.md");
    writeFileSync(outside, "outside\n");
    const probePath = join(root, ".agent-guidance-symlink-probe");
    if (!createSymlinkOrSkip(t, outside, probePath, "file")) return;
    rmSync(probePath);
    writeFileSync(
      join(root, ".agents", "guide.md"),
      `# Large race fixture\n\n${"x".repeat(8 * 1024 * 1024)}\n`,
    );

    const { child, completed } = runCliAsync(root, "sync");
    const deadline = Date.now() + 10_000;
    let injected = false;
    while (child.exitCode === null && Date.now() < deadline) {
      const temporaryAgentFile = readdirSync(root).find(
        (entry) => entry.startsWith(".AGENTS.md.") && entry.endsWith(".tmp"),
      );
      if (temporaryAgentFile) {
        symlinkSync(outside, join(root, "AGENTS.md"), "file");
        injected = true;
        break;
      }
      await delay(1);
    }

    const sync = await completed;
    assert.equal(injected, true, `Could not intercept staged write; stderr: ${sync.stderr}`);
    assert.equal(sync.status, 1);
    assert.equal(lstatSync(join(root, "AGENTS.md")).isSymbolicLink(), true);
    assert.equal(readFileSync(outside, "utf8"), "outside\n");
    assert.equal(lstatIfExists(join(root, "CLAUDE.md")), null);
    assert.equal(listFiles(root).some((path) => path.endsWith(".tmp")), false);
  },
);

test(
  "preserves POSIX mode bits when atomically updating an owned file",
  { skip: process.platform === "win32" },
  (t) => {
    const root = temporaryRepo(t);
    assert.equal(runCli(root, "sync").status, 0);
    const agentsPath = join(root, "AGENTS.md");
    chmodSync(agentsPath, 0o640);
    writeFileSync(join(root, ".agents", "guide.md"), "# Updated guide\n");

    const sync = runCli(root, "sync");
    assert.equal(sync.status, 0, sync.stderr);
    assert.equal(statSync(agentsPath).mode & 0o777, 0o640);
    assert.equal(listFiles(root).some((path) => path.endsWith(".tmp")), false);
  },
);

test(
  "preserves POSIX mode bits despite a restrictive process umask",
  { skip: process.platform === "win32" },
  (t) => {
    const root = temporaryRepo(t);
    assert.equal(runCli(root, "sync").status, 0);
    const agentsPath = join(root, "AGENTS.md");
    chmodSync(agentsPath, 0o664);
    writeFileSync(join(root, ".agents", "guide.md"), "# Updated under restrictive umask\n");

    const previousUmask = process.umask(0o077);
    let sync;
    try {
      sync = runCli(root, "sync");
    } finally {
      process.umask(previousUmask);
    }

    assert.equal(sync.status, 0, sync.stderr);
    assert.equal(statSync(agentsPath).mode & 0o777, 0o664);
  },
);

test("finds the nearest canonical source from a descendant directory", (t) => {
  const root = temporaryRepo(t);
  const nested = join(root, "packages", "app", "src");
  mkdirSync(nested, { recursive: true });

  const sync = runCli(nested, "sync");
  assert.equal(sync.status, 0, sync.stderr);
  assert.equal(read(root, "AGENTS.md"), read(expectedRoot, "AGENTS.md"));
  assert.equal(lstatIfExists(join(nested, "AGENTS.md")), null);
});

test("does not climb past a nested Git repository boundary", (t) => {
  const parentRoot = temporaryRepo(t);
  const nestedRepo = join(parentRoot, "nested-repository");
  const nestedDirectory = join(nestedRepo, "packages", "app");
  mkdirSync(join(nestedRepo, ".git"), { recursive: true });
  mkdirSync(nestedDirectory, { recursive: true });

  const sync = runCli(nestedDirectory, "sync");
  assert.equal(sync.status, 1);
  assert.match(sync.stderr, /Git repository boundary/);
  assert.equal(lstatIfExists(join(parentRoot, "AGENTS.md")), null);
  assert.equal(lstatIfExists(join(nestedRepo, "AGENTS.md")), null);
});

test(
  "rejects a symlinked canonical source in check and force modes",
  (t) => {
    const root = temporaryRepo(t);
    const sourcePath = join(root, ".agents", "guide.md");
    const outside = join(temporaryDirectory(t, "agent-guidance-source-"), "guide.md");
    writeFileSync(outside, "# Outside guidance\n");
    rmSync(sourcePath);
    if (!createSymlinkOrSkip(t, outside, sourcePath, "file")) return;

    for (const command of [["check"], ["sync", "--force"]]) {
      const result = runCli(root, ...command);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Canonical source must not be a symlink/);
    }
    assert.equal(readFileSync(outside, "utf8"), "# Outside guidance\n");
    assert.equal(lstatIfExists(join(root, "AGENTS.md")), null);
  },
);

test("rejects non-regular targets even in force mode", (t) => {
  const root = temporaryRepo(t);
  mkdirSync(join(root, "AGENTS.md"));

  const sync = runCli(root, "sync", "--force");
  assert.equal(sync.status, 1);
  assert.match(sync.stderr, /unsafe: AGENTS\.md .*not a regular file/);
  assert.equal(lstatSync(join(root, "AGENTS.md")).isDirectory(), true);
  assert.equal(lstatIfExists(join(root, "CLAUDE.md")), null);
});

test("supports guidance larger than the former Copilot instruction limit", (t) => {
  const root = temporaryRepo(t);
  const marker = "x".repeat(4_100);
  writeFileSync(join(root, ".agents", "guide.md"), `# Large guide\n\n${marker}\n`);

  const sync = runCli(root, "sync");
  assert.equal(sync.status, 0, sync.stderr);
  assert.ok(read(root, "AGENTS.md").length > 4_000);
  assert.ok(read(root, ".cursor/rules/agent-guidance.mdc").includes(marker));
  assert.ok(read(root, ".github/copilot-instructions.md").includes(marker));
  assert.equal(runCli(root, "check").status, 0);
});

test("reports missing sources and invalid CLI combinations without writing", (t) => {
  const root = temporaryDirectory(t);

  const missing = runCli(root, "check");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Could not find \.agents\/guide\.md/);

  const invalid = runCli(root, "sync", "--adopt", "--force");
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /mutually exclusive/);

  const maskedInvalid = runCli(root, "sync", "--unknown", "--help");
  assert.equal(maskedInvalid.status, 2);
  assert.match(maskedInvalid.stderr, /--help cannot be combined/);

  const duplicate = runCli(root, "sync", "--adopt", "--adopt");
  assert.equal(duplicate.status, 2);
  assert.match(duplicate.stderr, /Duplicate option: --adopt/);

  const commandHelp = runCli(root, "sync", "--help");
  assert.equal(commandHelp.status, 0, commandHelp.stderr);
  assert.match(commandHelp.stdout, /missing, stale, unmanaged, or unsafe/);
  assert.deepEqual(listFiles(root), []);
});

test("reports the package metadata version", () => {
  const version = runCli(packageRoot, "--version");
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout, `${packageMetadata.version}\n`);
});

test("packs, installs, and runs the published artifact", (t) => {
  const artifactRoot = temporaryDirectory(t, "agent-guidance-artifact-");
  const consumerRoot = temporaryDirectory(t, "agent-guidance-consumer-");
  const npmCache = join(artifactRoot, "npm-cache");
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const npmEnvironment = { ...process.env, npm_config_cache: npmCache };

  const pack = spawnSync(
    npmCommand,
    ["pack", "--json", "--pack-destination", artifactRoot],
    {
      cwd: packageRoot,
      encoding: "utf8",
      env: npmEnvironment,
      shell: process.platform === "win32",
    },
  );
  assert.equal(pack.status, 0, pack.stderr);
  const [{ filename }] = JSON.parse(pack.stdout);
  const tarballPath = join(artifactRoot, filename);
  writeFileSync(join(consumerRoot, "package.json"), '{"private":true}\n');

  const install = spawnSync(
    npmCommand,
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save=false", tarballPath],
    {
      cwd: consumerRoot,
      encoding: "utf8",
      env: npmEnvironment,
      shell: process.platform === "win32",
    },
  );
  assert.equal(install.status, 0, install.stderr);

  const installedCli = join(
    consumerRoot,
    "node_modules",
    "@martinmqz",
    "agent-guidance-sync",
    "bin",
    "agent-guidance.mjs",
  );
  const installedBin = join(
    consumerRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "agent-guidance.cmd" : "agent-guidance",
  );
  assert.ok(lstatIfExists(installedBin));
  const version = spawnSync(process.execPath, [installedCli, "--version"], {
    cwd: consumerRoot,
    encoding: "utf8",
  });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout, `${packageMetadata.version}\n`);
});

function lstatIfExists(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
}
