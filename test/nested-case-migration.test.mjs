import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { INITIAL_CONFIG, checkProject, planProject, syncProject } from "../src/index.mjs";

const cliPath = fileURLToPath(new URL("../bin/agent-guidance.mjs", import.meta.url));
const inventoryPath = ".agents/nested-outputs.json";
const nestedNames = ["AGENTS.md", "CLAUDE.md"];

function rule(scope) {
  return `---\ndescription: Scoped guidance\nactivation: path\npaths:\n  - ${scope}/**\n---\n# Scoped guidance\nApply throughout this directory.\n`;
}

function repository(t, scope = "src") {
  const root = mkdtempSync(join(tmpdir(), "guidance-case-migration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".agents/rules"), { recursive: true });
  writeFileSync(join(root, ".agents/guide.md"), "# Guide\n");
  writeFileSync(join(root, ".agents/config.yaml"), `${INITIAL_CONFIG}nested: true\n`);
  writeFileSync(join(root, ".agents/rules/scoped.md"), rule(scope));
  assert.equal(syncProject(root).ok, true);
  return root;
}

function read(root, path) {
  return readFileSync(join(root, path), "utf8");
}

function cli(root, ...args) {
  return spawnSync(process.execPath, [cliPath, ...args], { cwd: root, encoding: "utf8" });
}

test("equivalent nested scopes migrate according to actual filesystem identities", (t) => {
  for (const [previous, current] of [["src", "Src"], ["caf\u00e9", "cafe\u0301"]]) {
    for (const takeover of ["none", "adopt", "force"]) {
      const root = repository(t, previous);
      const aliases = existsSync(join(root, `${current}/AGENTS.md`));
      writeFileSync(join(root, ".agents/rules/scoped.md"), rule(current));
      const before = read(root, `${previous}/AGENTS.md`);
      const flags = takeover === "none" ? [] : [`--${takeover}`];
      const preview = cli(root, "sync", "--dry-run", "--json", ...flags);
      assert.equal(preview.status, 0, preview.stderr);
      assert.equal(read(root, `${previous}/AGENTS.md`), before);
      const plan = JSON.parse(preview.stdout).plan;
      for (const name of nestedNames) {
        assert.equal(plan.find(({ path }) => path === `${current}/${name}`).action,
          aliases ? "update" : "create");
        assert.equal(plan.some(({ action, path }) => action === "delete" && path === `${previous}/${name}`),
          !aliases);
      }
      const result = cli(root, "sync", ...flags);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(checkProject(root).ok, true);
      assert.deepEqual(JSON.parse(read(root, inventoryPath)).paths, nestedNames.map((name) => `${current}/${name}`));
      for (const name of nestedNames) {
        assert.ok(read(root, `${current}/${name}`).includes(`target="${current}/${name}"`));
        if (!aliases) assert.equal(existsSync(join(root, `${previous}/${name}`)), false);
      }
    }
  }
});

test("interrupted equivalent-scope migrations can be disabled or removed without orphaned aliases", (t) => {
  for (const [previous, current] of [["src", "Src"], ["caf\u00e9", "cafe\u0301"]]) {
    for (const failure of ["nested", "inventory"]) {
      for (const cleanup of ["disable", "remove-rule"]) {
        const root = repository(t, previous);
        const aliases = existsSync(join(root, `${current}/AGENTS.md`));
        writeFileSync(join(root, ".agents/rules/scoped.md"), rule(current));
        const hook = failure === "nested"
          ? 'target === "CLAUDE.md"'
          : 'target === "nested-outputs.json" && ++inventories === 2';
        const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
let injected = false;
let inventories = 0;
for (const method of ["renameSync", "linkSync"]) {
  const original = fs[method];
  fs[method] = (source, target) => {
    if (${hook}) { injected = true; throw new Error("Injected migration failure"); }
    return original(source, target);
  };
}
syncBuiltinESMExports();
const { syncProject } = await import(${JSON.stringify(new URL("../src/index.mjs", import.meta.url).href)});
let failed = false;
try { syncProject(${JSON.stringify(root)}); } catch { failed = true; }
if (!injected || !failed) throw new Error("Migration failure was not injected");
`], { encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        if (cleanup === "disable") writeFileSync(join(root, ".agents/config.yaml"), INITIAL_CONFIG);
        else rmSync(join(root, ".agents/rules/scoped.md"));
        const deletionPaths = planProject(root).filter(({ action }) => action === "delete").map(({ relativePath }) => relativePath);
        assert.equal(new Set(deletionPaths).size, deletionPaths.length);
        if (aliases) {
          for (const name of nestedNames) {
            assert.equal(deletionPaths.filter((path) => path.normalize("NFC").toLowerCase() === `${previous}/${name}`.normalize("NFC").toLowerCase()).length, 1);
          }
        }
        assert.equal(syncProject(root).ok, true);
        assert.equal(checkProject(root).ok, true);
        for (const directory of [previous, current]) {
          for (const name of nestedNames) assert.equal(existsSync(join(root, `${directory}/${name}`)), false);
        }
      }
    }
  }
});

test("case migration recovers inventories containing both aliases and mixed ownership markers", (t) => {
  const root = repository(t);
  if (!existsSync(join(root, "Src/AGENTS.md"))) {
    t.skip("Case aliases require a case-insensitive filesystem");
    return;
  }
  writeFileSync(join(root, ".agents/rules/scoped.md"), rule("Src"));
  const inventory = JSON.parse(read(root, inventoryPath));
  inventory.paths.push(...nestedNames.map((name) => `Src/${name}`));
  writeFileSync(join(root, inventoryPath), `${JSON.stringify(inventory, null, 2)}\n`);
  writeFileSync(join(root, "Src/AGENTS.md"), read(root, "src/AGENTS.md").replace('target="src/AGENTS.md"', 'target="Src/AGENTS.md"'));
  const plan = planProject(root);
  assert.equal(plan.find(({ relativePath }) => relativePath === "Src/AGENTS.md").action, "unchanged");
  assert.equal(plan.find(({ relativePath }) => relativePath === "Src/CLAUDE.md").action, "update");
  assert.equal(plan.some(({ action, relativePath }) => action === "delete" && relativePath.startsWith("src/")), false);
  assert.equal(syncProject(root).ok, true);
  assert.equal(checkProject(root).ok, true);
  assert.deepEqual(JSON.parse(read(root, inventoryPath)).paths, nestedNames.map((name) => `Src/${name}`));
});

test("separate hard links in case-distinct directories remain separate planned targets", (t) => {
  const root = repository(t);
  if (existsSync(join(root, "Src/AGENTS.md"))) {
    t.skip("Distinct case-only directories require a case-sensitive filesystem");
    return;
  }
  mkdirSync(join(root, "Src"));
  for (const name of nestedNames) linkSync(join(root, `src/${name}`), join(root, `Src/${name}`));
  writeFileSync(join(root, ".agents/rules/scoped.md"), rule("Src"));
  const plan = planProject(root, { takeover: "force" });
  for (const name of nestedNames) {
    assert.equal(plan.find(({ relativePath }) => relativePath === `Src/${name}`).action, "replace");
    assert.equal(plan.find(({ relativePath }) => relativePath === `src/${name}`).action, "delete");
  }
  assert.equal(syncProject(root, { takeover: "force" }).ok, true);
  assert.equal(checkProject(root).ok, true);
  for (const name of nestedNames) assert.equal(existsSync(join(root, `src/${name}`)), false);
});

test("a case-only spelling change does not claim unmanaged nested contents", (t) => {
  const root = repository(t);
  writeFileSync(join(root, "src/AGENTS.md"), "# Personal instructions\n");
  writeFileSync(join(root, ".agents/rules/scoped.md"), rule("Src"));
  const inventory = read(root, inventoryPath);
  for (const takeover of ["none", "adopt", "force"]) {
    assert.equal(syncProject(root, { takeover }).ok, false);
    assert.equal(read(root, "src/AGENTS.md"), "# Personal instructions\n");
    assert.equal(read(root, inventoryPath), inventory);
  }
});
