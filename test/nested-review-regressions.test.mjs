import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkProject, GuidanceError, INITIAL_CONFIG, syncProject } from "../src/index.mjs";

const cliPath = fileURLToPath(new URL("../bin/agent-guidance.mjs", import.meta.url));
const moduleUrl = new URL("../src/index.mjs", import.meta.url).href;
const inventoryPath = ".agents/nested-outputs.json";
function write(root, path, contents) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
}
function read(root, path) { return readFileSync(join(root, path), "utf8"); }
function rule(root, path, name = "scope") {
  write(root, `.agents/rules/${name}.md`, `---\ndescription: Scope\nactivation: path\npaths:\n  - "${path}"\n---\n# Scope ${name}\n`);
}
function project(t) {
  const root = mkdtempSync(join(tmpdir(), "guidance-nested-review-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(root, ".agents/guide.md", "# Guide\n");
  write(root, ".agents/config.yaml", `${INITIAL_CONFIG}nested: true\n`);
  return root;
}
function snapshot(root, directory = "") {
  return readdirSync(join(root, directory), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)
    .flatMap((entry) => {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      return entry.isSymbolicLink() ? [[path, { symlink: readlinkSync(join(root, path)) }]]
        : entry.isDirectory() ? [[path, null], ...snapshot(root, path)] : [[path, read(root, path)]];
    });
}
function cli(root, ...args) { return spawnSync(process.execPath, [cliPath, ...args], { cwd: root, encoding: "utf8" }); }

test("missing or differently spelled nested scopes fail before any filesystem changes", (t) => {
  for (const [existing, scoped] of [["Scripts", "Scirpts"], ["scripts", "Scripts"], ["src/Tools", "src/tools"], ["caf\u00e9", "cafe\u0301"]]) {
    const root = project(t);
    mkdirSync(join(root, existing), { recursive: true });
    rule(root, `${scoped}/**`);
    // Some filesystems normalize directory entries at creation. Select the
    // spelling that demonstrably differs from readdir, rather than assuming it.
    if (existing.normalize("NFC") === scoped.normalize("NFC") && existing !== scoped && readdirSync(root).includes(scoped)) {
      rule(root, `${existing}/**`);
    }
    const before = snapshot(root);
    for (const args of [["check"], ["sync"], ["sync", "--dry-run", "--json"], ["sync", "--adopt"], ["sync", "--force"]]) {
      const result = cli(root, ...args);
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /must exist with exact spelling/);
      assert.deepEqual(snapshot(root), before);
    }
  }
});

test("nested target names do not silently reuse differently spelled existing files", (t) => {
  const root = project(t);
  write(root, "src/agents.md", "# Personal\n");
  rule(root, "src/**");
  if (!existsSync(join(root, "src/AGENTS.md"))) {
    t.skip("Filename aliases require a case-insensitive filesystem");
    return;
  }
  const before = snapshot(root);
  for (const takeover of ["none", "adopt", "force"]) {
    const result = syncProject(root, { takeover });
    assert.equal(result.ok, false);
    assert.match(result.plan.find(({ action }) => action === "unsafe").reason, /exact spelling/);
    assert.deepEqual(snapshot(root), before);
  }
});

test("BOM inventories support check, updates, recovery publication, and cleanup", (t) => {
  const root = project(t);
  mkdirSync(join(root, "src"));
  rule(root, "src/**");
  assert.equal(syncProject(root).ok, true);
  write(root, inventoryPath, `\uFEFF${read(root, inventoryPath)}`);
  assert.equal(checkProject(root).ok, true);
  assert.equal(cli(root, "sync", "--dry-run", "--json").status, 0);
  mkdirSync(join(root, "next"));
  rule(root, "next/**");
  assert.equal(syncProject(root).ok, true);
  assert.equal(existsSync(join(root, "src/AGENTS.md")), false);
  write(root, inventoryPath, `\uFEFF${read(root, inventoryPath)}`);
  write(root, ".agents/config.yaml", INITIAL_CONFIG);
  assert.equal(syncProject(root).ok, true);
  assert.equal(existsSync(join(root, inventoryPath)), false);
  assert.equal(checkProject(root).ok, true);
});

test("inventory errors identify the inventory and offer recovery that does not rely on force", (t) => {
  for (const contents of ["not json", JSON.stringify({ generatedBy: "agent-guidance-sync", version: 1, paths: ["a:b/AGENTS.md"] }), JSON.stringify({ generatedBy: "agent-guidance-sync", version: 1, paths: ["con/AGENTS.md"] })]) {
    const root = project(t);
    write(root, inventoryPath, contents);
    const before = snapshot(root);
    assert.throws(() => syncProject(root, { takeover: "force" }), (error) => error instanceof GuidanceError && /nested inventory.*\.agents\/nested-outputs.json/u.test(error.message));
    for (const args of [["check"], ["sync", "--dry-run", "--json"], ["sync", "--force"]]) {
      const result = cli(root, ...args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /known-good generated copy/);
      assert.doesNotMatch(result.stderr, /Rule \.agents|use --force|SyntaxError/);
      assert.equal(result.stdout, "");
      assert.deepEqual(snapshot(root), before);
    }
  }
});

test("obsolete unmanaged nested files explain manual recovery and are preserved under every takeover mode", (t) => {
  const root = project(t);
  mkdirSync(join(root, "src"));
  rule(root, "src/**");
  assert.equal(syncProject(root).ok, true);
  write(root, "src/AGENTS.md", "# Personal\n");
  rmSync(join(root, ".agents/rules/scope.md"));
  const before = snapshot(root);
  for (const flags of [[], ["--adopt"], ["--force"], ["--dry-run", "--json"]]) {
    const result = cli(root, "sync", ...flags);
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /move\/remove it explicitly/);
    assert.doesNotMatch(result.stdout + result.stderr, /use --force/);
    assert.deepEqual(snapshot(root), before);
  }
  renameSync(join(root, "src/AGENTS.md"), join(root, "src/personal.md"));
  assert.equal(syncProject(root).ok, true);
  assert.equal(read(root, "src/personal.md"), "# Personal\n");
  assert.equal(existsSync(join(root, inventoryPath)), false);
});

test("reserved directory rules retain scoped adapters when nested output is enabled", (t) => {
  const root = project(t);
  const config = read(root, ".agents/config.yaml").replace("cursor: true", "cursor: rules-only").replace("copilot: true", "copilot: rules-only");
  write(root, ".agents/config.yaml", config);
  for (const [index, glob] of [".agents/**", ".git/**", "node_modules/pkg/**", ".cursor/rules/agent-guidance/custom/**", ".github/instructions/agent-guidance/custom/**", ".CURSOR/RULES/AGENT-GUIDANCE/custom/**"].entries()) rule(root, glob, `rule-${index}`);
  assert.equal(syncProject(root).ok, true);
  assert.equal(existsSync(join(root, inventoryPath)), false);
  for (let index = 0; index < 6; index += 1) {
    assert.match(read(root, `.cursor/rules/agent-guidance/rule-${index}.mdc`), new RegExp(`# Scope rule-${index}`));
    assert.match(read(root, `.github/instructions/agent-guidance/rule-${index}.instructions.md`), new RegExp(`# Scope rule-${index}`));
  }
  assert.equal(checkProject(root).ok, true);
  write(root, ".agents/config.yaml", config.replaceAll("rules-only", "false"));
  const before = snapshot(root);
  assert.throws(() => syncProject(root), /Path-activated rules require/);
  assert.deepEqual(snapshot(root), before);
});

test("no empty inventory is created and previous empty inventories are removed", (t) => {
  for (const disableAgents of [false, true]) {
    const root = project(t);
    if (disableAgents) {
      write(root, ".agents/config.yaml", read(root, ".agents/config.yaml").replace("agents: true", "agents: false").replace("claude: true", "claude: false"));
      rule(root, "missing/**");
    }
    assert.equal(syncProject(root).ok, true);
    assert.equal(existsSync(join(root, inventoryPath)), false);
    write(root, inventoryPath, JSON.stringify({ generatedBy: "agent-guidance-sync", version: 1, paths: [] }));
    assert.equal(syncProject(root).ok, true);
    assert.equal(existsSync(join(root, inventoryPath)), false);
    assert.equal(checkProject(root).ok, true);
  }
});

test("rules-only adapters use nested guidance once and retain narrower rules and full-mode compatibility", (t) => {
  const root = project(t);
  mkdirSync(join(root, "src"));
  rule(root, "src/**");
  rule(root, "src/**/*.ts", "narrow");
  assert.equal(syncProject(root).ok, true);
  const config = read(root, ".agents/config.yaml");
  write(root, ".agents/config.yaml", config.replace("cursor: true", "cursor: rules-only").replace("copilot: true", "copilot: rules-only"));
  const preview = cli(root, "sync", "--dry-run", "--json");
  assert.equal(preview.status, 0, preview.stderr);
  const removed = JSON.parse(preview.stdout).plan.filter(({ action }) => action === "delete").map(({ path }) => path);
  assert.ok(removed.includes(".cursor/rules/agent-guidance/scope.mdc"));
  assert.ok(removed.includes(".github/instructions/agent-guidance/scope.instructions.md"));
  assert.equal(syncProject(root).ok, true);
  for (const [directory, extension] of [[".cursor/rules/agent-guidance", ".mdc"], [".github/instructions/agent-guidance", ".instructions.md"]]) {
    assert.equal(existsSync(join(root, `${directory}/scope${extension}`)), false);
    assert.ok(read(root, `${directory}/narrow${extension}`).includes("# Scope narrow"));
  }
  assert.ok(read(root, "src/AGENTS.md").includes("# Scope scope"));
  assert.equal(checkProject(root).ok, true);
  write(root, ".agents/config.yaml", config);
  assert.equal(syncProject(root).ok, true);
  assert.ok(existsSync(join(root, ".github/instructions/agent-guidance/scope.instructions.md")));
  write(root, ".agents/config.yaml", config.replace("nested: true", "nested: false").replace("cursor: true", "cursor: rules-only"));
  assert.equal(syncProject(root).ok, true);
  assert.ok(existsSync(join(root, ".cursor/rules/agent-guidance/scope.mdc")));
  assert.equal(existsSync(join(root, "src/AGENTS.md")), false);
});

test("the initial inventory uses canonical path ordering and is published only once", (t) => {
  const root = project(t);
  for (const name of ["a", "a-b"]) {
    mkdirSync(join(root, name));
    rule(root, `${name}/**`, name);
  }
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
let published = 0;
for (const method of ["renameSync", "linkSync"]) {
  const original = fs[method];
  fs[method] = (source, target) => {
    if (target === "nested-outputs.json") published += 1;
    return original(source, target);
  };
}
syncBuiltinESMExports();
const { syncProject } = await import(${JSON.stringify(moduleUrl)});
if (!syncProject(${JSON.stringify(root)}).ok || published !== 1) throw new Error("Expected one inventory publication; got " + published);
`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(read(root, inventoryPath)).paths, ["a-b/AGENTS.md", "a-b/CLAUDE.md", "a/AGENTS.md", "a/CLAUDE.md"]);
  assert.equal(checkProject(root).ok, true);
});


test("enabled rules-only adapters reject unsafe namespaces even with no emitted path rules", (t) => {
  for (const [adapter, parent] of [["cursor", ".cursor/rules"], ["copilot", ".github/instructions"]]) {
    const root = project(t);
    rule(root, "src/*.js");
    assert.equal(syncProject(root).ok, true);
    const outside = project(t);
    renameSync(join(root, parent), join(outside, "stored-rules"));
    try {
      symlinkSync(join(outside, "stored-rules"), join(root, parent), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        t.skip("Directory symlinks unavailable");
        return;
      }
      throw error;
    }
    rmSync(join(root, ".agents/rules/scope.md"));
    write(root, ".agents/config.yaml", read(root, ".agents/config.yaml").replace(`${adapter}: true`, `${adapter}: rules-only`));
    const before = snapshot(root);
    const outsideBefore = snapshot(outside);
    for (const args of [["check"], ["sync"], ["sync", "--force"], ["sync", "--dry-run", "--json"]]) {
      const result = cli(root, ...args);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stdout + result.stderr, /symlink/);
      assert.deepEqual(snapshot(root), before);
      assert.deepEqual(snapshot(outside), outsideBefore);
    }
  }
});

test("missing adapter diagnostics list only the supported values for that adapter", (t) => {
  for (const adapter of ["agents", "claude", "cursor", "copilot"]) {
    const root = project(t);
    write(root, ".agents/config.yaml", INITIAL_CONFIG.replace(`  ${adapter}: true\n`, ""));
    const result = cli(root, "check");
    assert.equal(result.status, 1);
    const choices = ["cursor", "copilot"].includes(adapter) ? "true|false|rules-only" : "true|false";
    assert.ok(result.stderr.includes(`adapters.${adapter}: ${choices}.`));
  }
});

test("a scope removed after planning is not recreated during staging", (t) => {
  const root = project(t);
  mkdirSync(join(root, "src"));
  rule(root, "src/**");
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const original = fs.openSync;
let injected = false;
fs.openSync = (path, flags, ...rest) => {
  if (!injected && flags === "wx" && String(path).startsWith(".AGENTS.md.")) {
    injected = true;
    fs.rmdirSync(${JSON.stringify(join(root, "src"))});
  }
  return original(path, flags, ...rest);
};
syncBuiltinESMExports();
const { syncProject, GuidanceError } = await import(${JSON.stringify(moduleUrl)});
let failure;
try { syncProject(${JSON.stringify(root)}); } catch (error) { failure = error; }
if (!injected || !(failure instanceof GuidanceError)) throw new Error("Missing scope-removal failure");
`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(root, "src")), false);
  assert.equal(existsSync(join(root, "AGENTS.md")), false);
  assert.equal(existsSync(join(root, inventoryPath)), false);
  assert.equal(snapshot(root).some(([path]) => path.endsWith(".tmp")), false);
});
