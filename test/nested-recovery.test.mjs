import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { checkProject, INITIAL_CONFIG, syncProject } from "../src/index.mjs";

const moduleUrl = new URL("../src/index.mjs", import.meta.url).href;
const inventoryPath = ".agents/nested-outputs.json";

function project(t, directory = "Old") {
  const root = mkdtempSync(join(tmpdir(), "agent-guidance-nested-recovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".agents/rules"), { recursive: true });
  writeFileSync(join(root, ".agents/config.yaml"), `${INITIAL_CONFIG}nested: true\n`);
  writeFileSync(join(root, ".agents/guide.md"), "# Root guidance\n");
  scope(root, directory);
  return root;
}

function scope(root, directory) {
  writeFileSync(join(root, ".agents/rules/scope.md"),
    `---\ndescription: Scoped guidance\nactivation: path\npaths:\n  - "${directory}/**"\n---\n# Scoped guidance\n`);
}

function read(root, path) {
  return readFileSync(join(root, path), "utf8");
}

function snapshot(root, directory = "") {
  return readdirSync(join(root, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      return entry.isDirectory() ? snapshot(root, path) : [[path, read(root, path)]];
    });
}

function failSync(root, hook) {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
const root = ${JSON.stringify(root)};
let injected = false;
${hook}
syncBuiltinESMExports();
const { syncProject } = await import(${JSON.stringify(moduleUrl)});
let failure = null;
try { syncProject(root); } catch (error) { failure = error; }
if (!injected) throw new Error("Failure hook did not run");
if (!failure) throw new Error("Synchronization unexpectedly succeeded");
`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function disableAndClean(root) {
  writeFileSync(join(root, ".agents/config.yaml"), INITIAL_CONFIG);
  assert.equal(syncProject(root).ok, true);
  assert.equal(checkProject(root).ok, true);
  assert.equal(existsSync(join(root, inventoryPath)), false);
}

test("new nested guidance is not published when initial inventory publication fails", (t) => {
  const root = project(t);
  const before = snapshot(root);
  failSync(root, `
const original = fs.linkSync;
fs.linkSync = (source, target) => {
  if (target === "nested-outputs.json") { injected = true; throw new Error("Injected inventory publication failure"); }
  return original(source, target);
};`);
  assert.deepEqual(snapshot(root), before);
  disableAndClean(root);
  assert.equal(existsSync(join(root, "Old/AGENTS.md")), false);
});

test("initial partial nested publication retains discovery paths for a changed configuration", (t) => {
  const root = project(t);
  failSync(root, `
const original = fs.linkSync;
fs.linkSync = (source, target) => {
  if (target === "CLAUDE.md" && basename(process.cwd()) === "Old") {
    injected = true; throw new Error("Injected nested publication failure");
  }
  return original(source, target);
};`);
  assert.equal(existsSync(join(root, "Old/AGENTS.md")), true);
  assert.deepEqual(JSON.parse(read(root, inventoryPath)).paths, ["Old/AGENTS.md", "Old/CLAUDE.md"]);
  disableAndClean(root);
  assert.equal(existsSync(join(root, "Old/AGENTS.md")), false);
});

test("new nested paths wait until a replacement recovery inventory is published", (t) => {
  const root = project(t);
  assert.equal(syncProject(root).ok, true);
  scope(root, "New");
  const before = snapshot(root);
  failSync(root, `
const original = fs.renameSync;
fs.renameSync = (source, target) => {
  if (target === "nested-outputs.json") { injected = true; throw new Error("Injected recovery publication failure"); }
  return original(source, target);
};`);
  assert.deepEqual(snapshot(root), before);
  disableAndClean(root);
  assert.equal(existsSync(join(root, "Old/AGENTS.md")), false);
  assert.equal(existsSync(join(root, "New/AGENTS.md")), false);
});

test("failed final inventory publication retains both old and newly published paths", (t) => {
  const root = project(t);
  assert.equal(syncProject(root).ok, true);
  scope(root, "New");
  failSync(root, `
const original = fs.renameSync;
let inventories = 0;
fs.renameSync = (source, target) => {
  if (target === "nested-outputs.json" && ++inventories === 2) {
    injected = true; throw new Error("Injected final inventory publication failure");
  }
  return original(source, target);
};`);
  assert.equal(existsSync(join(root, "New/AGENTS.md")), true);
  assert.equal(existsSync(join(root, "Old/AGENTS.md")), false);
  assert.deepEqual(JSON.parse(read(root, inventoryPath)).paths,
    ["New/AGENTS.md", "New/CLAUDE.md", "Old/AGENTS.md", "Old/CLAUDE.md"]);
  disableAndClean(root);
  assert.equal(existsSync(join(root, "New/AGENTS.md")), false);
  assert.equal(existsSync(join(root, "New/CLAUDE.md")), false);
});

test("recovery inventory staging failures preserve all targets", (t) => {
  const root = project(t);
  assert.equal(syncProject(root).ok, true);
  scope(root, "New");
  const before = snapshot(root);
  failSync(root, `
const original = fs.openSync;
let inventories = 0;
fs.openSync = (path, flags, ...rest) => {
  if (flags === "wx" && String(path).startsWith(".nested-outputs.json.") && ++inventories === 2) {
    injected = true; throw new Error("Injected recovery staging failure");
  }
  return original(path, flags, ...rest);
};`);
  assert.deepEqual(snapshot(root), before);
});

test("successful nested migration reports one final inventory update and removes recovery state", (t) => {
  const root = project(t);
  assert.equal(syncProject(root).ok, true);
  scope(root, "New");
  const result = syncProject(root);
  assert.equal(result.ok, true);
  assert.deepEqual(result.changed.filter(({ relativePath }) => relativePath === inventoryPath)
    .map(({ action }) => action), ["update"]);
  assert.deepEqual(JSON.parse(read(root, inventoryPath)).paths, ["New/AGENTS.md", "New/CLAUDE.md"]);
  assert.equal(existsSync(join(root, "Old/AGENTS.md")), false);
  assert.equal(existsSync(join(root, "New/AGENTS.md")), true);
  assert.equal(snapshot(root).some(([path]) => path.endsWith(".tmp")), false);
  assert.equal(checkProject(root).ok, true);
});
