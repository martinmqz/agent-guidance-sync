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
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { INITIAL_CONFIG, INITIAL_GUIDE, initProject, renderTargets } from "../src/index.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageMetadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const cliPath = join(packageRoot, "bin", "agent-guidance.mjs");
const fixtureRoot = join(packageRoot, "test", "fixtures", "basic");
const expectedRoot = join(fixtureRoot, "expected");
const scopedFixtureRoot = join(packageRoot, "test", "fixtures", "scoped");
const scopedExpectedRoot = join(scopedFixtureRoot, "expected");
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

function snapshotFiles(root) {
  return Object.fromEntries(
    listFiles(root).map((relativePath) => [relativePath, read(root, relativePath)]),
  );
}

test("initializes the Git repository root without generating targets", (t) => {
  const root = temporaryDirectory(t);
  const nested = join(root, "packages", "app");
  mkdirSync(join(root, ".git"));
  mkdirSync(nested, { recursive: true });

  const init = runCli(nested, "init");
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /Initialized agent guidance/);
  assert.match(init.stdout, /created: \.agents\/guide\.md/);
  assert.match(init.stdout, /created: \.agents\/config\.yaml/);
  assert.equal(read(root, ".agents/guide.md"), INITIAL_GUIDE);
  assert.equal(read(root, ".agents/config.yaml"), INITIAL_CONFIG);
  assert.equal(lstatIfExists(join(nested, ".agents")), null);
  for (const relativePath of generatedPaths) {
    assert.equal(lstatIfExists(join(root, relativePath)), null);
  }
  assert.equal(listFiles(root).some((path) => path.endsWith(".tmp")), false);
});

test("initializes the current directory when no Git repository is present", (t) => {
  const root = temporaryDirectory(t);
  const nested = join(root, "standalone");
  mkdirSync(nested);

  const init = runCli(nested, "init");
  assert.equal(init.status, 0, init.stderr);
  assert.equal(read(nested, ".agents/guide.md"), INITIAL_GUIDE);
  assert.equal(read(nested, ".agents/config.yaml"), INITIAL_CONFIG);
  assert.equal(lstatIfExists(join(root, ".agents")), null);
});

test("init is idempotent and never overwrites an existing canonical source", (t) => {
  const root = temporaryDirectory(t);
  const existingGuide = "# Existing repository guidance\n";
  write(root, ".agents/guide.md", existingGuide);

  const init = runCli(root, "init");
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /created: \.agents\/config\.yaml/);
  assert.equal(read(root, ".agents/guide.md"), existingGuide);
  assert.equal(read(root, ".agents/config.yaml"), INITIAL_CONFIG);

  const secondInit = runCli(root, "init");
  assert.equal(secondInit.status, 0, secondInit.stderr);
  assert.match(secondInit.stdout, /already initialized/);
  assert.equal(read(root, ".agents/guide.md"), existingGuide);
});

test(
  "init can add missing config without reading an existing guide",
  { skip: process.platform === "win32" },
  (t) => {
    const root = temporaryDirectory(t);
    const guidePath = join(root, ".agents", "guide.md");
    write(root, ".agents/guide.md", "# Existing unreadable guide\n");
    chmodSync(guidePath, 0o000);

    let init;
    try {
      init = runCli(root, "init");
    } finally {
      chmodSync(guidePath, 0o600);
    }

    assert.equal(init.status, 0, init.stderr);
    assert.match(init.stdout, /created: \.agents\/config\.yaml/);
    assert.equal(read(root, ".agents/guide.md"), "# Existing unreadable guide\n");
    assert.equal(read(root, ".agents/config.yaml"), INITIAL_CONFIG);
  },
);

test(
  "init creates the canonical source directory with bounded permissions",
  { skip: process.platform === "win32" },
  (t) => {
    const root = temporaryDirectory(t);
    const previousUmask = process.umask(0o000);
    let init;
    try {
      init = runCli(root, "init");
    } finally {
      process.umask(previousUmask);
    }

    assert.equal(init.status, 0, init.stderr);
    assert.equal(statSync(join(root, ".agents")).mode & 0o777, 0o755);
  },
);

test("init preserves its public result contract while exposing created paths", (t) => {
  const root = temporaryDirectory(t);
  const initialized = initProject(root);
  assert.equal(initialized.created, true);
  assert.equal(initialized.createdAny, true);
  assert.deepEqual(initialized.createdPaths, [".agents/guide.md", ".agents/config.yaml"]);
  assert.equal(initialized.sourcePath, join(root, ".agents", "guide.md"));

  const repeated = initProject(root);
  assert.equal(repeated.created, false);
  assert.equal(repeated.createdAny, false);
  assert.deepEqual(repeated.createdPaths, []);
  assert.deepEqual(repeated.existingPaths, [".agents/guide.md", ".agents/config.yaml"]);

  const migrationRoot = temporaryDirectory(t);
  write(migrationRoot, ".agents/guide.md", "# Existing guide\n");
  const migrated = initProject(migrationRoot);
  assert.equal(migrated.created, false);
  assert.equal(migrated.createdAny, true);
  assert.deepEqual(migrated.createdPaths, [".agents/config.yaml"]);
});

test("concurrent init calls converge without overwriting canonical files", async (t) => {
  const root = temporaryDirectory(t);
  const attempts = Array.from({ length: 12 }, () => runCliAsync(root, "init").completed);
  const results = await Promise.all(attempts);
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  assert.equal(read(root, ".agents/guide.md"), INITIAL_GUIDE);
  assert.equal(read(root, ".agents/config.yaml"), INITIAL_CONFIG);
  assert.equal(listFiles(root).some((path) => path.endsWith(".tmp")), false);
});

test("init rejects symlinked canonical source paths without following them", (t) => {
  const directoryRoot = temporaryDirectory(t);
  const outsideDirectory = temporaryDirectory(t, "agent-guidance-init-outside-");
  if (!createSymlinkOrSkip(t, outsideDirectory, join(directoryRoot, ".agents"), "dir")) return;

  const directoryResult = runCli(directoryRoot, "init");
  assert.equal(directoryResult.status, 1);
  assert.match(directoryResult.stderr, /Canonical source directory must not be a symlink/);
  assert.deepEqual(listFiles(outsideDirectory), []);

  const fileRoot = temporaryDirectory(t);
  mkdirSync(join(fileRoot, ".agents"));
  const outsideGuide = join(outsideDirectory, "outside-guide.md");
  writeFileSync(outsideGuide, "# Outside guide\n");
  if (!createSymlinkOrSkip(t, outsideGuide, join(fileRoot, ".agents", "guide.md"), "file")) return;

  const fileResult = runCli(fileRoot, "init");
  assert.equal(fileResult.status, 1);
  assert.match(fileResult.stderr, /Canonical source must not be a symlink/);
  assert.equal(readFileSync(outsideGuide, "utf8"), "# Outside guide\n");

  const configRoot = temporaryDirectory(t);
  mkdirSync(join(configRoot, ".agents"));
  if (!createSymlinkOrSkip(t, outsideGuide, join(configRoot, ".agents", "config.yaml"), "file")) {
    return;
  }
  const configResult = runCli(configRoot, "init");
  assert.equal(configResult.status, 1);
  assert.match(configResult.stderr, /Canonical source must not be a symlink/);
  assert.equal(lstatIfExists(join(configRoot, ".agents", "guide.md")), null);
});

test("init never stages temporary files through a replaced source directory", (t) => {
  const root = temporaryDirectory(t);
  const agentsPath = join(root, ".agents");
  const movedAgentsPath = join(root, ".agents-original");
  const outside = temporaryDirectory(t, "agent-guidance-init-race-outside-");
  mkdirSync(agentsPath);
  const probePath = join(root, ".agent-guidance-init-race-probe");
  if (!createSymlinkOrSkip(t, outside, probePath, "dir")) return;
  rmSync(probePath);

  const script = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname } from "node:path";

const root = ${JSON.stringify(root)};
const agentsPath = ${JSON.stringify(agentsPath)};
const movedAgentsPath = ${JSON.stringify(movedAgentsPath)};
const outside = ${JSON.stringify(outside)};
const originalOpenSync = fs.openSync;
let swapped = false;
fs.openSync = (path, flags, mode) => {
  if (!swapped && typeof path === "string" && path.endsWith(".tmp")) {
    fs.renameSync(agentsPath, movedAgentsPath);
    fs.symlinkSync(outside, agentsPath, process.platform === "win32" ? "junction" : "dir");
    swapped = true;
  }
  const descriptor = originalOpenSync(path, flags, mode);
  if (
    swapped &&
    typeof path === "string" &&
    fs.realpathSync(${JSON.stringify(outside)}) === fs.realpathSync(dirname(path))
  ) {
    process.stdout.write("external-temp-opened\\n");
  }
  return descriptor;
};
syncBuiltinESMExports();

const { initProject } = await import(${JSON.stringify(pathToFileURL(join(packageRoot, "src", "index.mjs")).href)});
let failure = null;
try {
  initProject(root);
} catch (error) {
  failure = error;
}
if (!swapped) throw new Error("The source-directory substitution was not injected.");
if (!failure || !/changed during initialization/.test(failure.message)) throw failure;
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /external-temp-opened/);
  assert.deepEqual(listFiles(outside), []);
  assert.equal(listFiles(root).some((path) => path.endsWith(".tmp")), false);
  assert.equal(lstatSync(agentsPath).isSymbolicLink(), true);
  assert.ok(lstatSync(movedAgentsPath).isDirectory());
});

test("init rejects non-directory and non-regular canonical source paths", (t) => {
  const directoryRoot = temporaryDirectory(t);
  writeFileSync(join(directoryRoot, ".agents"), "not a directory\n");

  const directoryResult = runCli(directoryRoot, "init");
  assert.equal(directoryResult.status, 1);
  assert.match(directoryResult.stderr, /Canonical source path is not a directory/);
  assert.equal(readFileSync(join(directoryRoot, ".agents"), "utf8"), "not a directory\n");

  const fileRoot = temporaryDirectory(t);
  mkdirSync(join(fileRoot, ".agents", "guide.md"), { recursive: true });

  const fileResult = runCli(fileRoot, "init");
  assert.equal(fileResult.status, 1);
  assert.match(fileResult.stderr, /Canonical source is not a regular file/);
  assert.equal(lstatSync(join(fileRoot, ".agents", "guide.md")).isDirectory(), true);

  const configRoot = temporaryDirectory(t);
  mkdirSync(join(configRoot, ".agents", "config.yaml"), { recursive: true });
  const configResult = runCli(configRoot, "init");
  assert.equal(configResult.status, 1);
  assert.match(configResult.stderr, /Canonical source is not a regular file/);
  assert.equal(lstatIfExists(join(configRoot, ".agents", "guide.md")), null);
});

test("generates deterministic repository-wide guidance for every supported agent", (t) => {
  const root = temporaryRepo(t);

  const initialCheck = runCli(root, "check");
  assert.equal(initialCheck.status, 1);
  for (const relativePath of generatedPaths) {
    assert.match(initialCheck.stderr, new RegExp(`missing: ${relativePath.replaceAll(".", "\\.")}`));
  }
  assert.deepEqual(listFiles(root), [".agents/config.yaml", ".agents/guide.md"]);

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

test("generates deterministic always and path-activated rule adapters", (t) => {
  const root = temporaryDirectory(t);
  cpSync(join(scopedFixtureRoot, ".agents"), join(root, ".agents"), { recursive: true });
  const scopedGeneratedPaths = listFiles(scopedExpectedRoot);

  const initialCheck = runCli(root, "check");
  assert.equal(initialCheck.status, 1);
  for (const relativePath of scopedGeneratedPaths) {
    assert.match(initialCheck.stderr, new RegExp(`missing: ${relativePath.replaceAll(".", "\\.")}`));
  }

  const sync = runCli(root, "sync");
  assert.equal(sync.status, 0, sync.stderr);
  for (const relativePath of scopedGeneratedPaths) {
    assert.equal(read(root, relativePath), read(scopedExpectedRoot, relativePath));
  }
  assert.equal(runCli(root, "check").status, 0);
  assert.match(read(root, "AGENTS.md"), /agent-guidance-sync:rule source="\.agents\/rules\/quality\.md"/);
  assert.doesNotMatch(read(root, "AGENTS.md"), /React Components/);
});

test("ignores auxiliary regular files in the canonical rules tree", (t) => {
  const root = temporaryDirectory(t);
  cpSync(join(scopedFixtureRoot, ".agents"), join(root, ".agents"), { recursive: true });
  write(root, ".agents/rules/.DS_Store", "finder metadata\n");
  write(root, ".agents/rules/.gitkeep", "");
  write(root, ".agents/rules/README.md", "# Rule authoring notes\n");
  write(root, ".agents/rules/frontend/react.md.swp", "editor state\n");

  const sync = runCli(root, "sync");
  assert.equal(sync.status, 0, sync.stderr);
  assert.equal(runCli(root, "check").status, 0);
  for (const relativePath of listFiles(scopedExpectedRoot)) {
    assert.equal(read(root, relativePath), read(scopedExpectedRoot, relativePath));
  }
});

test("strips a leading UTF-8 BOM from every canonical input", (t) => {
  const root = temporaryDirectory(t);
  cpSync(join(scopedFixtureRoot, ".agents"), join(root, ".agents"), { recursive: true });
  for (const relativePath of [
    ".agents/guide.md",
    ".agents/config.yaml",
    ".agents/rules/quality.md",
    ".agents/rules/frontend/react.md",
  ]) {
    writeFileSync(join(root, relativePath), `\uFEFF${read(root, relativePath)}`);
  }

  const sync = runCli(root, "sync");
  assert.equal(sync.status, 0, sync.stderr);
  assert.equal(runCli(root, "check").status, 0);
  for (const relativePath of listFiles(scopedExpectedRoot)) {
    const contents = read(root, relativePath);
    assert.equal(contents.includes("\uFEFF"), false, relativePath);
    assert.equal(contents, read(scopedExpectedRoot, relativePath));
  }
});

test("rendered targets expose only their consumed public fields", () => {
  const [target] = renderTargets("# Guide\n");
  assert.deepEqual(Object.keys(target).sort(), [
    "contents",
    "relativePath",
    "unmanagedContents",
  ]);
});

test("removes obsolete owned scoped outputs and preserves neighboring files", (t) => {
  const root = temporaryDirectory(t);
  cpSync(join(scopedFixtureRoot, ".agents"), join(root, ".agents"), { recursive: true });
  write(root, ".cursor/rules/personal.mdc", "# Personal Cursor guidance\n");
  write(root, ".github/instructions/personal.instructions.md", "# Personal Copilot guidance\n");
  assert.equal(runCli(root, "sync").status, 0);

  rmSync(join(root, ".agents", "rules", "frontend", "react.md"));
  const check = runCli(root, "check");
  assert.equal(check.status, 1);
  assert.match(check.stderr, /obsolete: \.cursor\/rules\/agent-guidance\/frontend\/react\.mdc/);
  assert.match(
    check.stderr,
    /obsolete: \.github\/instructions\/agent-guidance\/frontend\/react\.instructions\.md/,
  );

  const sync = runCli(root, "sync");
  assert.equal(sync.status, 0, sync.stderr);
  assert.equal(lstatIfExists(join(root, ".cursor/rules/agent-guidance/frontend/react.mdc")), null);
  assert.equal(
    lstatIfExists(
      join(root, ".github/instructions/agent-guidance/frontend/react.instructions.md"),
    ),
    null,
  );
  assert.equal(lstatIfExists(join(root, ".cursor/rules/agent-guidance")), null);
  assert.equal(lstatIfExists(join(root, ".github/instructions/agent-guidance")), null);
  assert.equal(read(root, ".cursor/rules/personal.mdc"), "# Personal Cursor guidance\n");
  assert.equal(
    read(root, ".github/instructions/personal.instructions.md"),
    "# Personal Copilot guidance\n",
  );
  assert.equal(runCli(root, "check").status, 0);
});

test("does not remove a symlink substituted for an obsolete scoped output", (t) => {
  const root = temporaryDirectory(t);
  cpSync(join(scopedFixtureRoot, ".agents"), join(root, ".agents"), { recursive: true });
  assert.equal(runCli(root, "sync").status, 0);
  const staleCursorPath = join(root, ".cursor/rules/agent-guidance/frontend/react.mdc");
  const outside = join(temporaryDirectory(t, "agent-guidance-obsolete-outside-"), "rule.mdc");
  writeFileSync(outside, "outside\n");
  rmSync(join(root, ".agents", "rules", "frontend", "react.md"));
  rmSync(staleCursorPath);
  if (!createSymlinkOrSkip(t, outside, staleCursorPath, "file")) return;

  const sync = runCli(root, "sync", "--force");
  assert.equal(sync.status, 1);
  assert.match(sync.stderr, /unsafe: \.cursor\/rules\/agent-guidance\/frontend\/react\.mdc/);
  assert.equal(lstatSync(staleCursorPath).isSymbolicLink(), true);
  assert.equal(readFileSync(outside, "utf8"), "outside\n");
  assert.ok(
    lstatIfExists(
      join(root, ".github/instructions/agent-guidance/frontend/react.instructions.md"),
    ),
  );
});

test("stale-output discovery never traverses parent directory symlinks", (t) => {
  const cursorRoot = temporaryRepo(t);
  writeFileSync(
    join(cursorRoot, ".agents", "config.yaml"),
    `version: 1
adapters:
  agents: true
  claude: true
  cursor: true
  copilot: true
`,
  );
  const outsideCursor = temporaryDirectory(t, "agent-guidance-disabled-cursor-outside-");
  write(outsideCursor, "rules/agent-guidance.mdc", read(expectedRoot, ".cursor/rules/agent-guidance.mdc"));
  if (!createSymlinkOrSkip(t, outsideCursor, join(cursorRoot, ".cursor"), "dir")) return;

  const cursorSync = runCli(cursorRoot, "sync", "--force");
  assert.equal(cursorSync.status, 1);
  assert.match(cursorSync.stderr, /generated path traverses a symlink: \.cursor/);
  assert.equal(lstatIfExists(join(cursorRoot, "AGENTS.md")), null);
  assert.equal(
    read(outsideCursor, "rules/agent-guidance.mdc"),
    read(expectedRoot, ".cursor/rules/agent-guidance.mdc"),
  );

  const namespaceRoot = temporaryRepo(t);
  const outsideInstructions = temporaryDirectory(
    t,
    "agent-guidance-copilot-namespace-outside-",
  );
  const stalePath = "agent-guidance/stale.instructions.md";
  write(
    outsideInstructions,
    stalePath,
    '<!-- agent-guidance-sync:generated:v1 source=".agents/rules/stale.md" target=".github/instructions/agent-guidance/stale.instructions.md" -->\n',
  );
  mkdirSync(join(namespaceRoot, ".github"));
  if (
    !createSymlinkOrSkip(
      t,
      outsideInstructions,
      join(namespaceRoot, ".github", "instructions"),
      "dir",
    )
  ) {
    return;
  }

  const namespaceSync = runCli(namespaceRoot, "sync", "--force");
  assert.equal(namespaceSync.status, 1);
  assert.match(namespaceSync.stderr, /generated path traverses a symlink: \.github\/instructions/);
  assert.equal(lstatIfExists(join(namespaceRoot, "AGENTS.md")), null);
  assert.match(read(outsideInstructions, stalePath), /source="\.agents\/rules\/stale\.md"/);
});

test("disabled adapters ignore unrelated symlinked vendor trees", (t) => {
  const scenarios = [
    {
      config: `version: 1
adapters:
  agents: true
  claude: true
  cursor: false
  copilot: true
`,
      disabledPath: ".cursor",
      enabledPath: ".github/copilot-instructions.md",
      name: "cursor",
    },
    {
      config: `version: 1
adapters:
  agents: true
  claude: true
  cursor: true
  copilot: false
`,
      disabledPath: ".github",
      enabledPath: ".cursor/rules/agent-guidance.mdc",
      name: "copilot",
    },
  ];

  for (const scenario of scenarios) {
    const root = temporaryRepo(t);
    const outside = temporaryDirectory(t, `agent-guidance-disabled-${scenario.name}-outside-`);
    writeFileSync(join(outside, "sentinel"), "outside\n");
    if (!createSymlinkOrSkip(t, outside, join(root, scenario.disabledPath), "dir")) return;
    writeFileSync(join(root, ".agents", "config.yaml"), scenario.config);

    const sync = runCli(root, "sync");
    assert.equal(sync.status, 0, sync.stderr);
    assert.equal(lstatSync(join(root, scenario.disabledPath)).isSymbolicLink(), true);
    assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "outside\n");
    assert.ok(lstatIfExists(join(root, "AGENTS.md")));
    assert.ok(lstatIfExists(join(root, "CLAUDE.md")));
    assert.ok(lstatIfExists(join(root, scenario.enabledPath)));
    assert.equal(runCli(root, "check").status, 0);
  }
});

test("obsolete ownership requires an exact version and source-to-target mapping", (t) => {
  const root = temporaryRepo(t);
  writeFileSync(
    join(root, ".agents", "config.yaml"),
    `version: 1
adapters:
  agents: false
  claude: false
  cursor: false
  copilot: false
`,
  );
  write(
    root,
    "AGENTS.md",
    '<!-- agent-guidance-sync:generated:v1 source=".agents/rules/not-agents.md" target="AGENTS.md" -->\n',
  );
  const wrongSourcePath = ".cursor/rules/agent-guidance/wrong-source.mdc";
  write(
    root,
    wrongSourcePath,
    `---
description: "Wrong source"
globs: ["**/*.md"]
alwaysApply: false
---

<!-- agent-guidance-sync:generated:v1 source=".agents/guide.md" target="${wrongSourcePath}" -->
`,
  );
  const wrongVersionPath = ".cursor/rules/agent-guidance/wrong-version.mdc";
  write(
    root,
    wrongVersionPath,
    `---
description: "Wrong version"
globs: ["**/*.md"]
alwaysApply: false
---

<!-- agent-guidance-sync:generated:v01 source=".agents/rules/wrong-version.md" target="${wrongVersionPath}" -->
`,
  );

  const check = runCli(root, "check");
  assert.equal(check.status, 1);
  assert.match(check.stderr, /unmanaged: \.cursor\/rules\/agent-guidance\/wrong-source\.mdc/);
  assert.match(check.stderr, /unmanaged: \.cursor\/rules\/agent-guidance\/wrong-version\.mdc/);
  assert.doesNotMatch(check.stderr, /obsolete/);

  const sync = runCli(root, "sync", "--force");
  assert.equal(sync.status, 1);
  assert.ok(lstatIfExists(join(root, "AGENTS.md")));
  assert.ok(lstatIfExists(join(root, wrongSourcePath)));
  assert.ok(lstatIfExists(join(root, wrongVersionPath)));
});

test("blocks all writes for unmanaged files inside reserved generated namespaces", (t) => {
  const root = temporaryDirectory(t);
  cpSync(join(scopedFixtureRoot, ".agents"), join(root, ".agents"), { recursive: true });
  assert.equal(runCli(root, "sync").status, 0);
  const originalAgents = read(root, "AGENTS.md");
  const roguePath = ".cursor/rules/agent-guidance/rogue.mdc";
  write(root, roguePath, "# Unmanaged reserved file\n");
  writeFileSync(join(root, ".agents", "guide.md"), "# Updated guide\n");

  for (const command of [["sync"], ["sync", "--force"]]) {
    const result = runCli(root, ...command);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unmanaged: \.cursor\/rules\/agent-guidance\/rogue\.mdc/);
    assert.match(result.stderr, /move or remove it explicitly/);
    assert.equal(read(root, roguePath), "# Unmanaged reserved file\n");
    assert.equal(read(root, "AGENTS.md"), originalAgents);
  }
});

test("disabled adapters remove only their exactly owned outputs", (t) => {
  const root = temporaryDirectory(t);
  cpSync(join(scopedFixtureRoot, ".agents"), join(root, ".agents"), { recursive: true });
  write(root, ".cursor/rules/personal.mdc", "# Personal Cursor guidance\n");
  write(root, ".github/instructions/personal.instructions.md", "# Personal Copilot guidance\n");
  assert.equal(runCli(root, "sync").status, 0);

  writeFileSync(
    join(root, ".agents", "config.yaml"),
    `version: 1
adapters:
  agents: true
  claude: true
  cursor: false
  copilot: false
`,
  );
  const check = runCli(root, "check");
  assert.equal(check.status, 1);
  assert.match(check.stderr, /obsolete: \.cursor\/rules\/agent-guidance\.mdc/);
  assert.match(check.stderr, /obsolete: \.github\/copilot-instructions\.md/);

  const sync = runCli(root, "sync");
  assert.equal(sync.status, 0, sync.stderr);
  assert.ok(lstatIfExists(join(root, "AGENTS.md")));
  assert.ok(lstatIfExists(join(root, "CLAUDE.md")));
  assert.equal(lstatIfExists(join(root, ".cursor/rules/agent-guidance.mdc")), null);
  assert.equal(lstatIfExists(join(root, ".cursor/rules/agent-guidance/frontend/react.mdc")), null);
  assert.equal(lstatIfExists(join(root, ".github/copilot-instructions.md")), null);
  assert.equal(
    lstatIfExists(
      join(root, ".github/instructions/agent-guidance/frontend/react.instructions.md"),
    ),
    null,
  );
  assert.equal(lstatIfExists(join(root, ".cursor/rules/agent-guidance")), null);
  assert.equal(lstatIfExists(join(root, ".github/instructions/agent-guidance")), null);
  assert.equal(read(root, ".cursor/rules/personal.mdc"), "# Personal Cursor guidance\n");
  assert.equal(
    read(root, ".github/instructions/personal.instructions.md"),
    "# Personal Copilot guidance\n",
  );
  assert.equal(runCli(root, "check").status, 0);
});

test("rejects invalid config and rule schemas before generating files", (t) => {
  const missingConfigRoot = temporaryRepo(t);
  rmSync(join(missingConfigRoot, ".agents", "config.yaml"));
  const missingConfig = runCli(missingConfigRoot, "check");
  assert.equal(missingConfig.status, 1);
  assert.match(missingConfig.stderr, /Missing canonical config/);
  assert.match(missingConfig.stderr, /agent-guidance init/);
  assert.equal(lstatIfExists(join(missingConfigRoot, "AGENTS.md")), null);

  const invalidConfigs = [
    ["version: 2\n", /needs version: 1/],
    ["version: 01\n", /needs version: 1/],
    [
      `adapters:
  agents: true
version: 1
  claude: true
  cursor: true
  copilot: true
`,
      /Invalid \.agents\/config\.yaml line/,
    ],
    [
      `version: 1
adapters:
  agents: false
  claude: true
  cursor: true
  copilot: true
`,
      /Claude adapter requires the AGENTS\.md adapter/,
    ],
  ];
  for (const [contents, expectedError] of invalidConfigs) {
    const root = temporaryRepo(t);
    writeFileSync(join(root, ".agents", "config.yaml"), contents);
    const check = runCli(root, "check");
    assert.equal(check.status, 1);
    assert.match(check.stderr, expectedError);
    assert.deepEqual(
      listFiles(root).filter((path) => !path.startsWith(".agents/")),
      [],
    );
  }

  const invalidRules = [
    [
      "bad-activation.md",
      `---
description: Invalid activation
activation: sometimes
---
# Invalid
`,
      /needs activation: always\|path/,
    ],
    [
      "missing-paths.md",
      `---
description: Missing paths
activation: path
---
# Missing Paths
`,
      /needs at least one path/,
    ],
    [
      "unsafe-path.md",
      `---
description: Unsafe path
activation: path
paths:
  - "../outside/**"
---
# Unsafe Path
`,
      /unsafe or non-portable path glob/,
    ],
    [
      "invalid-quote.md",
      `---
description: 'Broken' trailing'
activation: always
---
# Invalid Quote
`,
      /invalid quoted string/,
    ],
    [
      "always-paths.md",
      `---
description: Always with paths
activation: always
paths:
---
# Always Paths
`,
      /must not declare paths/,
    ],
    [
      "indented-heading.md",
      `---
description: Indented code heading
activation: always
---
    # Not a heading
`,
      /needs a level-one heading/,
    ],
    [
      "control-path.md",
      `---
description: Control path
activation: path
paths:
  - apps/\u0007/**
---
# Control Path
`,
      /unsafe or non-portable path glob/,
    ],
    [
      "inline-comment.md",
      `---
description: Inline comment
activation: path
paths:
  - apps/**/*.tsx # frontend
---
# Inline Comment
`,
      /unsupported plain-scalar YAML syntax/,
    ],
    [
      "windows-path.md",
      `---
description: Windows-invalid paths
activation: path
paths:
  - "apps/feature:legacy/**"
---
# Windows-invalid Paths
`,
      /unsafe or non-portable path glob/,
    ],
    [
      "trailing-dot-path.md",
      `---
description: Trailing dot path
activation: path
paths:
  - "apps/legacy./**"
---
# Trailing Dot Path
`,
      /unsafe or non-portable path glob/,
    ],
    [
      "yaml-flow-collection.md",
      `---
description: [Shared, testing]
activation: always
---
# YAML Flow Collection
`,
      /unsupported plain-scalar YAML syntax/,
    ],
    [
      "yaml-anchor.md",
      `---
description: &shared Shared
activation: always
---
# YAML Anchor
`,
      /unsupported plain-scalar YAML syntax/,
    ],
    [
      "yaml-colon.md",
      `---
description: Shared:
activation: always
---
# YAML Colon
`,
      /unsupported plain-scalar YAML syntax/,
    ],
    [
      "yaml-nested-sequence.md",
      `---
description: Nested sequence
activation: path
paths:
  - - apps/**
---
# YAML Nested Sequence
`,
      /unsupported plain-scalar YAML syntax/,
    ],
    [
      "windows-device-path.md",
      `---
description: Windows device path
activation: path
paths:
  - "packages/NUL.txt/**"
---
# Windows Device Path
`,
      /unsafe or non-portable path glob/,
    ],
  ];
  for (const [fileName, contents, expectedError] of invalidRules) {
    const root = temporaryRepo(t);
    write(root, `.agents/rules/${fileName}`, contents);
    const check = runCli(root, "check");
    assert.equal(check.status, 1);
    assert.match(check.stderr, expectedError);
    if (contents.includes("\u0007")) {
      assert.equal(check.stderr.includes("\u0007"), false);
      assert.match(check.stderr, /\\u0007/);
    }
    assert.equal(lstatIfExists(join(root, "AGENTS.md")), null);
  }
});

test("escapes untrusted filesystem names before writing terminal diagnostics", (t) => {
  if (process.platform === "win32") {
    t.skip("Windows does not support the control-character fixture name.");
    return;
  }

  const root = temporaryRepo(t);
  const unsafeName = "\u001b[31mspoof\nnext\u2028split\u202ereordered\u{1d173}.mdc";
  write(root, `.cursor/rules/agent-guidance/${unsafeName}`, "# Unmanaged\n");

  const check = runCli(root, "check");
  assert.equal(check.status, 1);
  assert.equal(check.stderr.includes("\u001b"), false);
  assert.equal(check.stderr.includes("\nnext"), false);
  assert.equal(check.stderr.includes("\u2028"), false);
  assert.equal(check.stderr.includes("\u202e"), false);
  assert.equal(check.stderr.includes("\u{1d173}"), false);
  assert.match(
    check.stderr,
    /\\u001b\[31mspoof\\nnext\\u2028split\\u202ereordered\\ud834\\udd73\.mdc/,
  );

  const jsonCheck = runCli(root, "check", "--json");
  assert.equal(jsonCheck.status, 1);
  assert.equal(jsonCheck.stderr, "");
  assert.equal(jsonCheck.stdout.includes("\u001b"), false);
  assert.equal(jsonCheck.stdout.includes("\u2028"), false);
  assert.equal(jsonCheck.stdout.includes("\u202e"), false);
  assert.equal(jsonCheck.stdout.includes("\u{1d173}"), false);
  const jsonResult = JSON.parse(jsonCheck.stdout);
  assert.ok(
    jsonResult.plan.some(
      ({ path }) => path === `.cursor/rules/agent-guidance/${unsafeName}`,
    ),
  );
});

test("rejects symlinked config and rule sources without following them", (t) => {
  const outsideRoot = temporaryDirectory(t, "agent-guidance-canonical-outside-");
  const outsideConfig = join(outsideRoot, "config.yaml");
  writeFileSync(outsideConfig, INITIAL_CONFIG);

  const configRoot = temporaryRepo(t);
  rmSync(join(configRoot, ".agents", "config.yaml"));
  if (!createSymlinkOrSkip(t, outsideConfig, join(configRoot, ".agents", "config.yaml"), "file")) {
    return;
  }
  const configCheck = runCli(configRoot, "check");
  assert.equal(configCheck.status, 1);
  assert.match(configCheck.stderr, /Canonical config must not be a symlink/);
  assert.equal(lstatIfExists(join(configRoot, "AGENTS.md")), null);

  const rulesRoot = temporaryRepo(t);
  const outsideRules = join(outsideRoot, "rules");
  mkdirSync(outsideRules);
  writeFileSync(join(outsideRules, "outside.md"), "outside\n");
  if (!createSymlinkOrSkip(t, outsideRules, join(rulesRoot, ".agents", "rules"), "dir")) return;
  const rulesCheck = runCli(rulesRoot, "check");
  assert.equal(rulesCheck.status, 1);
  assert.match(rulesCheck.stderr, /Canonical rules directory must not be a symlink/);
  assert.equal(readFileSync(join(outsideRules, "outside.md"), "utf8"), "outside\n");
  assert.equal(lstatIfExists(join(rulesRoot, "AGENTS.md")), null);
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

test("dry-run plans creates, updates, and deletions without mutating files", (t) => {
  const root = temporaryDirectory(t);
  cpSync(join(scopedFixtureRoot, ".agents"), join(root, ".agents"), { recursive: true });
  assert.equal(runCli(root, "sync").status, 0);

  writeFileSync(join(root, ".agents", "guide.md"), "# Changed repository guidance\n");
  rmSync(join(root, ".agents", "rules", "frontend", "react.md"));
  const before = snapshotFiles(root);

  const dryRun = runCli(root, "sync", "--dry-run");
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /Dry run: agent guidance would be synced; no files were changed/);
  assert.match(dryRun.stdout, /stale: AGENTS\.md/);
  assert.match(
    dryRun.stdout,
    /obsolete: \.cursor\/rules\/agent-guidance\/frontend\/react\.mdc/,
  );
  assert.match(
    dryRun.stdout,
    /obsolete: \.github\/instructions\/agent-guidance\/frontend\/react\.instructions\.md/,
  );
  assert.deepEqual(snapshotFiles(root), before);
  assert.equal(runCli(root, "check").status, 1);
});

test("dry-run honors takeover modes without claiming unmanaged files", (t) => {
  const root = temporaryRepo(t);
  write(root, "AGENTS.md", "# Existing unmanaged guidance\n");
  const before = snapshotFiles(root);

  const blocked = runCli(root, "sync", "--dry-run");
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /unmanaged: AGENTS\.md/);

  const forced = runCli(root, "sync", "--force", "--dry-run");
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /replace: AGENTS\.md/);
  assert.deepEqual(snapshotFiles(root), before);
});

test("emits a stable JSON lifecycle without exposing plan internals", (t) => {
  const root = temporaryDirectory(t);

  const init = runCli(root, "init", "--json");
  assert.equal(init.status, 0, init.stderr);
  assert.equal(init.stderr, "");
  assert.deepEqual(JSON.parse(init.stdout), {
    schemaVersion: 1,
    command: "init",
    ok: true,
    status: "initialized",
    root: realpathSync(root),
    createdPaths: [".agents/guide.md", ".agents/config.yaml"],
    existingPaths: [],
  });

  const initialCheck = runCli(root, "check", "--json");
  assert.equal(initialCheck.status, 1);
  assert.equal(initialCheck.stderr, "");
  const outOfSync = JSON.parse(initialCheck.stdout);
  assert.equal(outOfSync.schemaVersion, 1);
  assert.equal(outOfSync.command, "check");
  assert.equal(outOfSync.ok, false);
  assert.equal(outOfSync.status, "out-of-sync");
  assert.deepEqual(
    outOfSync.plan.map(({ action, path }) => [action, path]),
    generatedPaths.map((path) => ["create", path]),
  );
  assert.deepEqual(Object.keys(outOfSync.plan[0]), ["action", "path"]);

  const dryRun = runCli(root, "sync", "--dry-run", "--json");
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const planned = JSON.parse(dryRun.stdout);
  assert.equal(planned.status, "changes-planned");
  assert.equal(planned.dryRun, true);
  assert.equal(planned.takeover, "none");
  assert.deepEqual(planned.plan, outOfSync.plan);
  assert.equal(lstatIfExists(join(root, "AGENTS.md")), null);

  const sync = runCli(root, "sync", "--json");
  assert.equal(sync.status, 0, sync.stderr);
  const synced = JSON.parse(sync.stdout);
  assert.equal(synced.status, "synced");
  assert.equal(synced.dryRun, false);
  assert.equal(synced.plan.every(({ action }) => action === "create"), true);
  assert.deepEqual(synced.plan, outOfSync.plan);

  const finalCheck = runCli(root, "check", "--json");
  assert.equal(finalCheck.status, 0, finalCheck.stderr);
  const inSync = JSON.parse(finalCheck.stdout);
  assert.equal(inSync.status, "in-sync");
  assert.equal(inSync.plan.every(({ action }) => action === "unchanged"), true);

  const unchangedSync = runCli(root, "sync", "--json");
  assert.equal(unchangedSync.status, 0, unchangedSync.stderr);
  assert.equal(JSON.parse(unchangedSync.stdout).status, "unchanged");

  const secondInit = runCli(root, "init", "--json");
  assert.equal(secondInit.status, 0, secondInit.stderr);
  const unchangedInit = JSON.parse(secondInit.stdout);
  assert.equal(unchangedInit.status, "unchanged");
  assert.deepEqual(unchangedInit.createdPaths, []);
  assert.deepEqual(unchangedInit.existingPaths, [".agents/guide.md", ".agents/config.yaml"]);
});

test("emits JSON blocked states and errors on their documented streams", (t) => {
  const root = temporaryRepo(t);
  write(root, "AGENTS.md", "# Existing unmanaged guidance\n");

  const blocked = runCli(root, "sync", "--json");
  assert.equal(blocked.status, 1);
  assert.equal(blocked.stderr, "");
  const blockedResult = JSON.parse(blocked.stdout);
  assert.equal(blockedResult.ok, false);
  assert.equal(blockedResult.status, "blocked");
  assert.deepEqual(
    blockedResult.plan.find(({ path }) => path === "AGENTS.md"),
    {
      action: "conflict",
      path: "AGENTS.md",
      reason: "unmanaged content differs; use --force to replace it",
    },
  );
  assert.equal(lstatIfExists(join(root, "CLAUDE.md")), null);

  const usage = runCli(root, "sync", "--adopt", "--force", "--json");
  assert.equal(usage.status, 2);
  assert.equal(usage.stdout, "");
  assert.deepEqual(JSON.parse(usage.stderr), {
    schemaVersion: 1,
    command: "sync",
    ok: false,
    status: "error",
    error: {
      type: "usage",
      message: "--adopt and --force are mutually exclusive.",
    },
  });

  const missingRoot = temporaryDirectory(t);
  const guidanceError = runCli(missingRoot, "check", "--json");
  assert.equal(guidanceError.status, 1);
  assert.equal(guidanceError.stdout, "");
  const errorResult = JSON.parse(guidanceError.stderr);
  assert.equal(errorResult.command, "check");
  assert.equal(errorResult.error.type, "guidance");
  assert.match(errorResult.error.message, /Could not find \.agents\/guide\.md/);
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

test("adapter toggles never turn an unmanaged header position into ownership", (t) => {
  const root = temporaryRepo(t);
  const marker = read(expectedRoot, "AGENTS.md").split("\n")[0];
  const unmanaged = `---\ncustom: true\n---\n\n${marker}\n\n# Handwritten guidance\n`;
  write(root, "AGENTS.md", unmanaged);

  const enabledSync = runCli(root, "sync");
  assert.equal(enabledSync.status, 1);
  assert.match(enabledSync.stderr, /unmanaged: AGENTS\.md/);
  assert.equal(read(root, "AGENTS.md"), unmanaged);

  writeFileSync(
    join(root, ".agents", "config.yaml"),
    `version: 1
adapters:
  agents: false
  claude: false
  cursor: false
  copilot: false
`,
  );
  const disabledCheck = runCli(root, "check");
  assert.equal(disabledCheck.status, 0, disabledCheck.stderr);
  const disabledSync = runCli(root, "sync");
  assert.equal(disabledSync.status, 0, disabledSync.stderr);
  assert.equal(read(root, "AGENTS.md"), unmanaged);
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
  "does not create parent directories through a symlink introduced during staging",
  async (t) => {
    const root = temporaryRepo(t);
    const outside = temporaryDirectory(t, "agent-guidance-parent-race-outside-");
    const probePath = join(root, ".agent-guidance-directory-symlink-probe");
    if (!createSymlinkOrSkip(t, outside, probePath, "dir")) return;
    rmSync(probePath);
    writeFileSync(
      join(root, ".agents", "guide.md"),
      `# Large directory race fixture\n\n${"x".repeat(8 * 1024 * 1024)}\n`,
    );

    const { child, completed } = runCliAsync(root, "sync");
    const deadline = Date.now() + 10_000;
    let injected = false;
    while (child.exitCode === null && Date.now() < deadline) {
      const temporaryAgentFile = readdirSync(root).find(
        (entry) => entry.startsWith(".AGENTS.md.") && entry.endsWith(".tmp"),
      );
      if (temporaryAgentFile) {
        symlinkSync(
          outside,
          join(root, ".cursor"),
          process.platform === "win32" ? "junction" : "dir",
        );
        injected = true;
        break;
      }
      await delay(1);
    }

    const sync = await completed;
    assert.equal(injected, true, `Could not intercept staged write; stderr: ${sync.stderr}`);
    assert.equal(sync.status, 1);
    assert.match(sync.stderr, /generated path traverses a symlink: \.cursor/);
    assert.equal(lstatIfExists(join(outside, "rules")), null);
    assert.equal(lstatSync(join(root, ".cursor")).isSymbolicLink(), true);
    assert.equal(lstatIfExists(join(root, "AGENTS.md")), null);
    assert.equal(lstatIfExists(join(root, "CLAUDE.md")), null);
    assert.equal(listFiles(root).some((path) => path.endsWith(".tmp")), false);
  },
);

test(
  "does not publish earlier targets when a later write cannot be staged",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  (t) => {
    const root = temporaryRepo(t);
    const unwritableDirectory = join(root, ".github");
    mkdirSync(unwritableDirectory);
    chmodSync(unwritableDirectory, 0o555);

    let sync;
    try {
      sync = runCli(root, "sync");
    } finally {
      chmodSync(unwritableDirectory, 0o755);
    }

    assert.equal(sync.status, 1);
    assert.match(sync.stderr, /Could not stage atomic write for \.github\/copilot-instructions\.md/);
    for (const relativePath of generatedPaths) {
      assert.equal(lstatIfExists(join(root, relativePath)), null);
    }
    assert.equal(lstatIfExists(join(root, ".cursor")), null);
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

  const unknownOption = runCli(root, "sync", "--unknown");
  assert.equal(unknownOption.status, 2);
  assert.match(unknownOption.stderr, /Unknown option: --unknown/);

  const unknownCommand = runCli(root, "unknown", "--json");
  assert.equal(unknownCommand.status, 2);
  const unknownCommandError = JSON.parse(unknownCommand.stderr);
  assert.equal(unknownCommandError.command, null);
  assert.equal(unknownCommandError.error.message, "Unknown command: unknown");

  const invalidInit = runCli(root, "init", "--force");
  assert.equal(invalidInit.status, 2);
  assert.match(invalidInit.stderr, /init does not accept --adopt or --force/);

  const invalidInitDryRun = runCli(root, "init", "--dry-run");
  assert.equal(invalidInitDryRun.status, 2);
  assert.match(invalidInitDryRun.stderr, /init does not accept --dry-run/);

  const invalidCheckDryRun = runCli(root, "check", "--dry-run");
  assert.equal(invalidCheckDryRun.status, 2);
  assert.match(invalidCheckDryRun.stderr, /check does not accept --dry-run/);

  const duplicateJson = runCli(root, "check", "--json", "--json");
  assert.equal(duplicateJson.status, 2);
  assert.equal(JSON.parse(duplicateJson.stderr).error.message, "Duplicate option: --json");

  const commandHelp = runCli(root, "sync", "--help");
  assert.equal(commandHelp.status, 0, commandHelp.stderr);
  assert.match(commandHelp.stdout, /missing, stale, obsolete, unmanaged, or unsafe/);
  assert.match(commandHelp.stdout, /--dry-run/);
  assert.match(commandHelp.stdout, /--json/);
  assert.match(commandHelp.stdout, /outside reserved namespaces/);

  const initHelp = runCli(root, "init", "--help");
  assert.equal(initHelp.status, 0, initHelp.stderr);
  assert.match(initHelp.stdout, /without overwriting existing files/);
  assert.deepEqual(listFiles(root), []);
});

test("reports the package metadata version", () => {
  assert.equal(packageMetadata.scripts.check, "node bin/agent-guidance.mjs check");
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

  const init = spawnSync(process.execPath, [installedCli, "init", "--json"], {
    cwd: consumerRoot,
    encoding: "utf8",
  });
  assert.equal(init.status, 0, init.stderr);
  assert.equal(JSON.parse(init.stdout).status, "initialized");
  assert.equal(read(consumerRoot, ".agents/guide.md"), INITIAL_GUIDE);
  assert.equal(read(consumerRoot, ".agents/config.yaml"), INITIAL_CONFIG);

  const preview = spawnSync(
    process.execPath,
    [installedCli, "sync", "--dry-run", "--json"],
    {
      cwd: consumerRoot,
      encoding: "utf8",
    },
  );
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).status, "changes-planned");
  assert.equal(lstatIfExists(join(consumerRoot, "AGENTS.md")), null);

  const sync = spawnSync(process.execPath, [installedCli, "sync", "--json"], {
    cwd: consumerRoot,
    encoding: "utf8",
  });
  assert.equal(sync.status, 0, sync.stderr);
  assert.equal(JSON.parse(sync.stdout).status, "synced");
  for (const relativePath of generatedPaths) {
    assert.ok(lstatIfExists(join(consumerRoot, relativePath)));
  }

  const check = spawnSync(process.execPath, [installedCli, "check", "--json"], {
    cwd: consumerRoot,
    encoding: "utf8",
  });
  assert.equal(check.status, 0, check.stderr);
  assert.equal(JSON.parse(check.stdout).status, "in-sync");
});

function lstatIfExists(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
}
