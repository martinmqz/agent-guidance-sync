import { randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

const packageMetadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

export const VERSION = packageMetadata.version;
export const SOURCE_PATH = ".agents/guide.md";
export const CONFIG_PATH = ".agents/config.yaml";
export const RULES_PATH = ".agents/rules";
export const INITIAL_GUIDE = `# Repository Agent Guidance

Replace this text with the coding-agent instructions that apply throughout this
repository.
`;
export const INITIAL_CONFIG = `version: 1
adapters:
  agents: true
  claude: true
  cursor: true
  copilot: true
`;

const DEFAULT_ADAPTERS = Object.freeze({
  agents: true,
  claude: true,
  copilot: true,
  cursor: true,
});

const GENERATED_FORMAT_VERSION = 1;
const TARGET_PATHS = Object.freeze({
  agents: "AGENTS.md",
  claude: "CLAUDE.md",
  cursor: ".cursor/rules/agent-guidance.mdc",
  copilot: ".github/copilot-instructions.md",
});
const SCOPED_ADAPTERS = Object.freeze({
  cursor: Object.freeze({
    namespace: ".cursor/rules/agent-guidance",
    targetPath: TARGET_PATHS.cursor,
  }),
  copilot: Object.freeze({
    namespace: ".github/instructions/agent-guidance",
    targetPath: TARGET_PATHS.copilot,
  }),
});

export class GuidanceError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "GuidanceError";
  }
}

function lstatIfExists(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function hasSameFileIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function assertProjectRootUnchanged(root, expectedStats, operation) {
  const current = lstatIfExists(root);
  if (
    !current?.isDirectory() ||
    current.isSymbolicLink() ||
    !hasSameFileIdentity(current, expectedStats)
  ) {
    throw new GuidanceError(`Project root changed ${operation}: ${root}`);
  }
}

function withStableDirectory(path, expectedStats, changedMessage, operation) {
  const previousDirectory = process.cwd();
  const directoryPath = resolve(path);
  let descriptor = null;
  try {
    let opened;
    try {
      if (process.platform === "win32") {
        opened = lstatSync(directoryPath);
      } else {
        descriptor = openSync(
          directoryPath,
          fsConstants.O_RDONLY |
            (fsConstants.O_DIRECTORY ?? 0) |
            (fsConstants.O_NOFOLLOW ?? 0),
        );
        opened = fstatSync(descriptor);
      }
      if (
        !opened.isDirectory() ||
        opened.isSymbolicLink() ||
        !hasSameFileIdentity(opened, expectedStats)
      ) {
        throw new GuidanceError(changedMessage);
      }
      process.chdir(directoryPath);
    } catch (error) {
      if (error instanceof GuidanceError) throw error;
      throw new GuidanceError(changedMessage, { cause: error });
    }
    const current = lstatSync(".");
    const currentPath = lstatIfExists(directoryPath);
    if (
      !current.isDirectory() ||
      !hasSameFileIdentity(current, opened) ||
      !currentPath?.isDirectory() ||
      currentPath.isSymbolicLink() ||
      !hasSameFileIdentity(currentPath, opened)
    ) {
      throw new GuidanceError(changedMessage);
    }
    return operation();
  } finally {
    process.chdir(previousDirectory);
    if (descriptor !== null) closeSync(descriptor);
  }
}

function readStableRegularFile(path, expectedStats, label, displayPath = path) {
  let descriptor = null;
  try {
    const noFollowFlag = process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
    descriptor = openSync(path, fsConstants.O_RDONLY | noFollowFlag);
    const openedBefore = fstatSync(descriptor);
    if (!openedBefore.isFile() || !hasSameFileIdentity(openedBefore, expectedStats)) {
      throw new GuidanceError(`${label} changed before it could be read: ${displayPath}`);
    }

    const contents = readFileSync(descriptor, "utf8");
    const openedAfter = fstatSync(descriptor);
    const currentPath = lstatIfExists(path);
    if (
      !openedAfter.isFile() ||
      !hasSameFileIdentity(openedAfter, openedBefore) ||
      openedAfter.size !== openedBefore.size ||
      openedAfter.mtimeMs !== openedBefore.mtimeMs ||
      openedAfter.ctimeMs !== openedBefore.ctimeMs ||
      !currentPath?.isFile() ||
      currentPath.isSymbolicLink() ||
      !hasSameFileIdentity(currentPath, openedBefore)
    ) {
      throw new GuidanceError(`${label} changed while it was being read: ${displayPath}`);
    }
    return contents;
  } catch (error) {
    if (error instanceof GuidanceError) throw error;
    throw new GuidanceError(`Could not safely read ${label}: ${displayPath}`, { cause: error });
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function normalizeLineEndings(contents) {
  return contents.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
}

function normalizeGuide(contents) {
  const normalized = normalizeLineEndings(contents);
  if (!normalized.trim()) {
    throw new GuidanceError(`${SOURCE_PATH} must contain non-whitespace guidance.`);
  }
  return `${normalized.replace(/(?:\n[\t ]*)+$/u, "")}\n`;
}

function parseConfig(contents) {
  const adapters = {};
  let adaptersDeclared = false;
  let inAdapters = false;
  let version = null;

  for (const rawLine of normalizeLineEndings(contents).split("\n")) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
    if (rawLine.includes("\t")) {
      throw new GuidanceError(`${CONFIG_PATH} must use spaces, not tabs.`);
    }

    const versionMatch = /^version:\s*([0-9]+)\s*$/u.exec(rawLine);
    if (versionMatch) {
      if (version !== null) throw new GuidanceError(`${CONFIG_PATH} declares version more than once.`);
      version = versionMatch[1];
      inAdapters = false;
      continue;
    }
    if (/^adapters:\s*$/u.test(rawLine)) {
      if (adaptersDeclared) {
        throw new GuidanceError(`${CONFIG_PATH} declares adapters more than once.`);
      }
      adaptersDeclared = true;
      inAdapters = true;
      continue;
    }

    const adapterMatch = /^  ([a-z]+):\s*(true|false)\s*$/u.exec(rawLine);
    if (adapterMatch && inAdapters) {
      const [, name, enabled] = adapterMatch;
      if (!Object.hasOwn(DEFAULT_ADAPTERS, name)) {
        throw new GuidanceError(`Unsupported adapter in ${CONFIG_PATH}: ${name}`);
      }
      if (Object.hasOwn(adapters, name)) {
        throw new GuidanceError(`${CONFIG_PATH} declares adapter ${name} more than once.`);
      }
      adapters[name] = enabled === "true";
      continue;
    }
    throw new GuidanceError(`Invalid ${CONFIG_PATH} line: ${rawLine}`);
  }

  if (version !== "1") {
    throw new GuidanceError(`${CONFIG_PATH} needs version: 1.`);
  }
  if (!adaptersDeclared) {
    throw new GuidanceError(`${CONFIG_PATH} needs an adapters mapping.`);
  }
  for (const name of Object.keys(DEFAULT_ADAPTERS)) {
    if (!Object.hasOwn(adapters, name)) {
      throw new GuidanceError(`${CONFIG_PATH} needs adapters.${name}: true|false.`);
    }
  }
  if (adapters.claude && !adapters.agents) {
    throw new GuidanceError(`${CONFIG_PATH}: the Claude adapter requires the AGENTS.md adapter.`);
  }
  return { adapters, version: 1 };
}

function parseFrontmatterScalar(rawValue, relativePath, key) {
  const value = rawValue.trim();
  if (!value) throw new GuidanceError(`Rule ${relativePath} needs a value for ${key}.`);
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed !== "string") throw new Error("not a string");
      return parsed;
    } catch {
      throw new GuidanceError(
        `Rule ${relativePath} has an invalid double-quoted string for ${key}.`,
      );
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) {
      throw new GuidanceError(`Rule ${relativePath} has an invalid quoted string for ${key}.`);
    }
    const inner = value.slice(1, -1);
    for (let index = 0; index < inner.length; index += 1) {
      if (inner[index] !== "'") continue;
      if (inner[index + 1] !== "'") {
        throw new GuidanceError(`Rule ${relativePath} has an invalid quoted string for ${key}.`);
      }
      index += 1;
    }
    return inner.replaceAll("''", "'");
  }
  if (
    /(?:^|\s)#|:(?:\s|$)|^(?:[-?:](?:\s|$)|[,\[\]{}#&*!|>'"%@`])/u.test(value)
  ) {
    throw new GuidanceError(
      `Rule ${relativePath} has unsupported plain-scalar YAML syntax for ${key}; quote the value.`,
    );
  }
  return value;
}

function validateRuleGlob(glob, relativePath) {
  const segments = glob.split("/");
  const reservedWindowsName = /^(?:aux|com[1-9]|con|lpt[1-9]|nul|prn)(?:\.|$)/iu;
  if (
    !glob ||
    glob.startsWith("/") ||
    /^[A-Za-z]:/u.test(glob) ||
    glob.startsWith("!") ||
    glob.includes("\\") ||
    glob.includes(",") ||
    /[:"<>|]/u.test(glob) ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(glob) ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        /[. ]$/u.test(segment) ||
        reservedWindowsName.test(segment),
    )
  ) {
    throw new GuidanceError(`Rule ${relativePath} has an unsafe or non-portable path glob: ${glob}`);
  }
}

function validateRuleRelativePath(relativePath) {
  if (!relativePath.endsWith(".md")) {
    throw new GuidanceError(`Unsupported canonical rule file: ${RULES_PATH}/${relativePath}`);
  }
  const stem = relativePath.slice(0, -".md".length);
  const reservedWindowsName = /^(?:aux|com[1-9]|con|lpt[1-9]|nul|prn)$/u;
  if (
    !stem ||
    stem.split("/").some(
      (segment) =>
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(segment) || reservedWindowsName.test(segment),
    )
  ) {
    throw new GuidanceError(
      `Canonical rule paths must use lowercase kebab-case: ${RULES_PATH}/${relativePath}`,
    );
  }
}

function parseRule(contents, relativePath) {
  validateRuleRelativePath(relativePath);
  const normalized = normalizeLineEndings(contents);
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(normalized);
  if (!match) {
    throw new GuidanceError(`Rule ${relativePath} needs YAML frontmatter delimited by ---.`);
  }

  const frontmatter = {};
  let activeList = null;
  for (const rawLine of match[1].split("\n")) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
    if (rawLine.includes("\t")) {
      throw new GuidanceError(`Rule ${relativePath} frontmatter must use spaces, not tabs.`);
    }
    const listItem = /^  -\s+(.+)$/u.exec(rawLine);
    if (listItem && activeList === "paths") {
      frontmatter.paths.push(parseFrontmatterScalar(listItem[1], relativePath, "paths"));
      continue;
    }

    const keyMatch = /^([a-z]+):(?:\s*(.*))?$/u.exec(rawLine);
    if (!keyMatch) {
      throw new GuidanceError(`Invalid frontmatter in rule ${relativePath}: ${rawLine}`);
    }
    const [, key, rawValue = ""] = keyMatch;
    if (!["activation", "description", "paths"].includes(key)) {
      throw new GuidanceError(`Unsupported frontmatter key in rule ${relativePath}: ${key}`);
    }
    if (Object.hasOwn(frontmatter, key)) {
      throw new GuidanceError(`Rule ${relativePath} declares ${key} more than once.`);
    }
    if (key === "paths") {
      if (rawValue.trim()) {
        throw new GuidanceError(`Rule ${relativePath} paths must use an indented YAML list.`);
      }
      frontmatter.paths = [];
      activeList = "paths";
      continue;
    }
    frontmatter[key] = parseFrontmatterScalar(rawValue, relativePath, key);
    activeList = null;
  }

  if (!frontmatter.description?.trim()) {
    throw new GuidanceError(`Rule ${relativePath} needs a non-empty description.`);
  }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(frontmatter.description)) {
    throw new GuidanceError(`Rule ${relativePath} description contains a control character.`);
  }
  if (!["always", "path"].includes(frontmatter.activation)) {
    throw new GuidanceError(`Rule ${relativePath} needs activation: always|path.`);
  }
  const paths = frontmatter.paths ?? [];
  if (frontmatter.activation === "always" && Object.hasOwn(frontmatter, "paths")) {
    throw new GuidanceError(`Always-activated rule ${relativePath} must not declare paths.`);
  }
  if (frontmatter.activation === "path" && paths.length === 0) {
    throw new GuidanceError(`Path-activated rule ${relativePath} needs at least one path.`);
  }
  if (new Set(paths).size !== paths.length) {
    throw new GuidanceError(`Rule ${relativePath} declares a duplicate path glob.`);
  }
  for (const glob of paths) validateRuleGlob(glob, relativePath);

  const rawBody = normalized.slice(match[0].length);
  if (!rawBody.trim()) {
    throw new GuidanceError(`Rule ${relativePath} needs non-whitespace guidance.`);
  }
  const body = normalizeGuide(rawBody);
  const firstContentLine = body.split("\n").find((line) => line.trim());
  if (!firstContentLine || !/^ {0,3}#\s+\S/u.test(firstContentLine)) {
    throw new GuidanceError(`Rule ${relativePath} needs a level-one heading.`);
  }
  return {
    activation: frontmatter.activation,
    body,
    description: frontmatter.description.trim(),
    paths,
    relativePath,
  };
}

function validateRelativePath(relativePath) {
  if (
    !relativePath ||
    isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    /["<>\r\n]/u.test(relativePath) ||
    relativePath.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new GuidanceError(`Unsafe generated target path: ${JSON.stringify(relativePath)}`);
  }
}

function absoluteTargetPath(root, relativePath) {
  validateRelativePath(relativePath);
  const path = resolve(root, ...relativePath.split("/"));
  const relativePathFromRoot = relative(root, path);
  if (
    relativePathFromRoot === ".." ||
    relativePathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(relativePathFromRoot)
  ) {
    throw new GuidanceError(`Generated target escapes the project root: ${relativePath}`);
  }
  return path;
}

export function generatedMarker(targetPath, sourcePath = SOURCE_PATH) {
  validateRelativePath(targetPath);
  validateRelativePath(sourcePath);
  return `<!-- agent-guidance-sync:generated:v${GENERATED_FORMAT_VERSION} source="${sourcePath}" target="${targetPath}" -->`;
}

function cursorPreamble() {
  return `---
description: Repository-wide guidance generated from .agents/guide.md
alwaysApply: true
---

`;
}

function renderedTarget(relativePath, unmanagedContents, prefix = "", sourcePath = SOURCE_PATH) {
  const marker = generatedMarker(relativePath, sourcePath);
  return {
    relativePath,
    contents: `${prefix}${marker}\n\n${unmanagedContents}`,
    unmanagedContents: `${prefix}${unmanagedContents}`,
  };
}

function sharedGuide(guideContents, rules) {
  const sections = [normalizeGuide(guideContents).slice(0, -1)];
  for (const rule of rules.filter(({ activation }) => activation === "always")) {
    sections.push(
      `<!-- agent-guidance-sync:rule source="${RULES_PATH}/${rule.relativePath}" -->\n\n${rule.body.slice(0, -1)}`,
    );
  }
  return `${sections.join("\n\n")}\n`;
}

function scopedCursorPreamble(rule) {
  return `---
description: ${JSON.stringify(rule.description)}
globs: ${JSON.stringify(rule.paths)}
alwaysApply: false
---

`;
}

function scopedCopilotPreamble(rule) {
  return `---
applyTo: ${JSON.stringify(rule.paths.join(","))}
---

`;
}

function scopedTargetStem(rule) {
  return rule.relativePath.slice(0, -".md".length);
}

export function renderTargets(
  guideContents,
  { adapters = DEFAULT_ADAPTERS, rules = [] } = {},
) {
  if (adapters.claude && !adapters.agents) {
    throw new GuidanceError("The Claude adapter requires the AGENTS.md adapter.");
  }
  const orderedRules = [...rules].sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
  );
  const guide = sharedGuide(guideContents, orderedRules);
  const claudeImport = "@AGENTS.md\n";
  const cursorPrefix = cursorPreamble();
  const pathRules = orderedRules.filter(({ activation }) => activation === "path");
  const targets = [];

  if (adapters.agents) targets.push(renderedTarget(TARGET_PATHS.agents, guide));
  if (adapters.claude) targets.push(renderedTarget(TARGET_PATHS.claude, claudeImport));
  if (adapters.cursor) {
    targets.push(renderedTarget(TARGET_PATHS.cursor, guide, cursorPrefix));
    for (const rule of pathRules) {
      const relativePath = `${SCOPED_ADAPTERS.cursor.namespace}/${scopedTargetStem(rule)}.mdc`;
      targets.push(
        renderedTarget(
          relativePath,
          rule.body,
          scopedCursorPreamble(rule),
          `${RULES_PATH}/${rule.relativePath}`,
        ),
      );
    }
  }
  if (adapters.copilot) {
    targets.push(renderedTarget(TARGET_PATHS.copilot, guide));
    for (const rule of pathRules) {
      const relativePath = `${SCOPED_ADAPTERS.copilot.namespace}/${scopedTargetStem(rule)}.instructions.md`;
      targets.push(
        renderedTarget(
          relativePath,
          rule.body,
          scopedCopilotPreamble(rule),
          `${RULES_PATH}/${rule.relativePath}`,
        ),
      );
    }
  }
  return targets;
}

function inspectCanonicalSource(candidateRoot) {
  const agentsPath = join(candidateRoot, ".agents");
  const agentsStats = lstatIfExists(agentsPath);
  if (!agentsStats) return { found: false };
  if (agentsStats.isSymbolicLink()) {
    throw new GuidanceError(`Canonical source directory must not be a symlink: ${agentsPath}`);
  }
  if (!agentsStats.isDirectory()) {
    throw new GuidanceError(`Canonical source path is not a directory: ${agentsPath}`);
  }

  const sourcePath = join(agentsPath, "guide.md");
  const sourceStats = lstatIfExists(sourcePath);
  if (!sourceStats) return { found: false };
  if (sourceStats.isSymbolicLink()) {
    throw new GuidanceError(`Canonical source must not be a symlink: ${sourcePath}`);
  }
  if (!sourceStats.isFile()) {
    throw new GuidanceError(`Canonical source is not a regular file: ${sourcePath}`);
  }
  return { agentsPath, agentsStats, found: true, sourcePath, sourceStats };
}

export function findProjectRoot(startDirectory = process.cwd()) {
  let current = resolve(startDirectory);
  const startStats = lstatIfExists(current);
  if (!startStats?.isDirectory()) {
    throw new GuidanceError(`Starting path is not a directory: ${current}`);
  }

  while (true) {
    const source = inspectCanonicalSource(current);
    if (source.found) return current;
    if (lstatIfExists(join(current, ".git"))) {
      throw new GuidanceError(
        `Could not find ${SOURCE_PATH} before reaching Git repository boundary: ${current}`,
      );
    }
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) break;
    current = parent;
  }

  throw new GuidanceError(
    `Could not find ${SOURCE_PATH} in ${resolve(startDirectory)} or any parent directory.`,
  );
}

export function findInitializationRoot(startDirectory = process.cwd()) {
  const startingPath = resolve(startDirectory);
  const startStats = lstatIfExists(startingPath);
  if (!startStats?.isDirectory() || startStats.isSymbolicLink()) {
    throw new GuidanceError(`Starting path must be a real directory: ${startingPath}`);
  }

  let current = startingPath;
  while (true) {
    if (lstatIfExists(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) return startingPath;
    current = parent;
  }
}

export function initProject(root) {
  const projectRoot = resolve(root);
  const rootStats = lstatIfExists(projectRoot);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
    throw new GuidanceError(`Project root must be a real directory: ${projectRoot}`);
  }
  const rootChangedMessage = `Project root changed during initialization: ${projectRoot}`;

  const agentsPath = join(projectRoot, ".agents");
  let agentsStats = lstatIfExists(agentsPath);
  if (agentsStats?.isSymbolicLink()) {
    throw new GuidanceError(`Canonical source directory must not be a symlink: ${agentsPath}`);
  }
  if (agentsStats && !agentsStats.isDirectory()) {
    throw new GuidanceError(`Canonical source path is not a directory: ${agentsPath}`);
  }

  const sources = [
    { contents: INITIAL_GUIDE, relativePath: SOURCE_PATH },
    { contents: INITIAL_CONFIG, relativePath: CONFIG_PATH },
  ];
  const inspectSourceAtPath = (path, displayPath = path) => {
    const stats = lstatIfExists(path);
    if (!stats) return null;
    if (stats.isSymbolicLink()) {
      throw new GuidanceError(`Canonical source must not be a symlink: ${displayPath}`);
    }
    if (!stats.isFile()) {
      throw new GuidanceError(`Canonical source is not a regular file: ${displayPath}`);
    }
    return stats;
  };
  const inspectSource = (source) => {
    const path = absoluteTargetPath(projectRoot, source.relativePath);
    return inspectSourceAtPath(path);
  };

  for (const source of sources) inspectSource(source);
  if (!agentsStats) {
    agentsStats = withStableDirectory(
      projectRoot,
      rootStats,
      rootChangedMessage,
      () => {
        try {
          mkdirSync(".agents", { mode: 0o755 });
        } catch (error) {
          if (!error || typeof error !== "object" || error.code !== "EEXIST") {
            throw new GuidanceError(`Could not create canonical source directory: ${agentsPath}`, {
              cause: error,
            });
          }
        }
        const createdStats = lstatIfExists(".agents");
        if (createdStats?.isSymbolicLink()) {
          throw new GuidanceError(`Canonical source directory must not be a symlink: ${agentsPath}`);
        }
        if (!createdStats?.isDirectory()) {
          throw new GuidanceError(`Canonical source path is not a directory: ${agentsPath}`);
        }
        return createdStats;
      },
    );
  }

  const assertAgentsDirectoryUnchanged = () => {
    const current = lstatIfExists(agentsPath);
    if (
      !current?.isDirectory() ||
      current.isSymbolicLink() ||
      !hasSameFileIdentity(current, agentsStats)
    ) {
      throw new GuidanceError(`Canonical source directory changed during initialization: ${agentsPath}`);
    }
  };
  const existingPaths = new Set();
  const createdPaths = [];
  const staged = [];
  try {
    for (const source of sources) {
      assertAgentsDirectoryUnchanged();
      if (inspectSource(source)) {
        existingPaths.add(source.relativePath);
        continue;
      }

      const path = absoluteTargetPath(projectRoot, source.relativePath);
      const temporaryName =
        `.agent-guidance-init.${basename(path)}.${process.pid}.${randomUUID()}.tmp`;
      const temporaryPath = join(projectRoot, temporaryName);
      let descriptor = null;
      let temporaryIdentity = null;
      const stagedWrite = {
        committed: false,
        item: {
          ...source,
          action: "create",
          originalContents: null,
          originalIdentity: null,
        },
        path,
        temporaryIdentity: null,
        temporaryName,
        temporaryPath,
      };
      try {
        withStableDirectory(projectRoot, rootStats, rootChangedMessage, () => {
          descriptor = openSync(temporaryName, "wx", 0o666);
          temporaryIdentity = fstatSync(descriptor);
          stagedWrite.temporaryIdentity = temporaryIdentity;
          writeFileSync(descriptor, source.contents, "utf8");
          fsyncSync(descriptor);
          closeSync(descriptor);
          descriptor = null;
          const currentRoot = lstatIfExists(projectRoot);
          if (
            !currentRoot?.isDirectory() ||
            currentRoot.isSymbolicLink() ||
            !hasSameFileIdentity(currentRoot, rootStats)
          ) {
            if (temporaryFileIsOriginal(stagedWrite, temporaryName)) {
              rmSync(temporaryName, { force: true });
            }
            throw new GuidanceError(rootChangedMessage);
          }
          assertStagedFileUnchanged(
            stagedWrite,
            temporaryName,
            `${source.relativePath} temporary file changed during initialization.`,
          );
        });
        assertAgentsDirectoryUnchanged();
        if (inspectSource(source)) {
          existingPaths.add(source.relativePath);
          removeStagedTemporaryOrThrow(stagedWrite);
          continue;
        }
        staged.push(stagedWrite);
      } catch (error) {
        if (descriptor !== null) {
          try {
            closeSync(descriptor);
          } catch {
            // Preserve the initialization failure; cleanup is best-effort.
          }
        }
        if (temporaryIdentity) removeStagedTemporary(stagedWrite);
        throw error;
      }
    }
  } catch (error) {
    for (const stagedWrite of staged) removeStagedTemporary(stagedWrite);
    throw error;
  }

  try {
    for (const stagedWrite of staged) {
      assertAgentsDirectoryUnchanged();
      const targetName = basename(stagedWrite.path);
      const changedMessage =
        `Canonical source directory changed during initialization: ${agentsPath}`;
      const existingBeforePublication = withStableDirectory(
        agentsPath,
        agentsStats,
        changedMessage,
        () => inspectSourceAtPath(targetName, stagedWrite.path),
      );
      if (existingBeforePublication) {
        existingPaths.add(stagedWrite.item.relativePath);
        removeStagedTemporaryOrThrow(stagedWrite);
        continue;
      }
      assertStagedFileUnchanged(
        stagedWrite,
        stagedWrite.temporaryPath,
        `${stagedWrite.item.relativePath} temporary file changed before initialization.`,
      );
      try {
        const publication = withStableDirectory(
          agentsPath,
          agentsStats,
          changedMessage,
          () => {
            if (inspectSourceAtPath(targetName, stagedWrite.path)) return "existing";
            const currentRoot = lstatIfExists("..");
            if (
              !currentRoot?.isDirectory() ||
              currentRoot.isSymbolicLink() ||
              !hasSameFileIdentity(currentRoot, rootStats)
            ) {
              throw new GuidanceError(rootChangedMessage);
            }
            try {
              linkSync(join("..", stagedWrite.temporaryName), targetName);
            } catch (error) {
              if (
                error &&
                typeof error === "object" &&
                error.code === "EEXIST" &&
                inspectSourceAtPath(targetName, stagedWrite.path)
              ) {
                return "existing";
              }
              throw error;
            }
            const published = lstatIfExists(targetName);
            if (
              !published?.isFile() ||
              published.isSymbolicLink() ||
              !hasSameFileIdentity(published, stagedWrite.temporaryIdentity)
            ) {
              throw new GuidanceError(
                `${stagedWrite.item.relativePath} changed during initialization.`,
              );
            }
            try {
              assertStagedFileUnchanged(
                stagedWrite,
                targetName,
                `${stagedWrite.item.relativePath} contents changed during initialization.`,
              );
              assertAgentsDirectoryUnchanged();
            } catch (error) {
              if (hasSameFileIdentity(lstatIfExists(targetName), stagedWrite.temporaryIdentity)) {
                rmSync(targetName);
              }
              throw error;
            }
            return "created";
          },
        );
        if (publication === "existing") {
          existingPaths.add(stagedWrite.item.relativePath);
          removeStagedTemporaryOrThrow(stagedWrite);
          continue;
        }
        stagedWrite.committed = true;
        createdPaths.push(stagedWrite.item.relativePath);
        removeStagedTemporaryOrThrow(stagedWrite);
      } catch (error) {
        throw new GuidanceError(
          `Could not atomically create ${stagedWrite.item.relativePath}.`,
          { cause: error },
        );
      }
    }
  } catch (error) {
    for (const stagedWrite of staged) removeStagedTemporary(stagedWrite);
    const committed = staged.filter((stagedWrite) => stagedWrite.committed);
    const partialWriteMessage = committed.length > 0
      ? ` Already created: ${committed.map(({ item }) => item.relativePath).join(", ")}.`
      : " No canonical source files were created.";
    throw new GuidanceError(
      `${error instanceof Error ? error.message : String(error)}${partialWriteMessage}`,
      { cause: error },
    );
  }

  return {
    created: createdPaths.includes(SOURCE_PATH),
    createdAny: createdPaths.length > 0,
    createdPaths,
    existingPaths: sources
      .map(({ relativePath }) => relativePath)
      .filter((relativePath) => existingPaths.has(relativePath)),
    root: projectRoot,
    sourcePath: join(projectRoot, SOURCE_PATH),
  };
}

function parentPathIssue(root, targetPath) {
  const segments = dirname(targetPath).split("/").filter((segment) => segment !== ".");
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    const stats = lstatIfExists(current);
    if (!stats) return null;
    if (stats.isSymbolicLink()) {
      return `generated path traverses a symlink: ${relative(root, current).split(sep).join("/")}`;
    }
    if (!stats.isDirectory()) {
      return `generated path traverses a non-directory: ${relative(root, current).split(sep).join("/")}`;
    }
  }
  return null;
}

function removeEmptyDirectoryThroughParent(path, expectedIdentity) {
  const parent = dirname(path);
  const name = basename(path);
  const parentStats = lstatIfExists(parent);
  if (!parentStats?.isDirectory() || parentStats.isSymbolicLink()) return null;

  try {
    return withStableDirectory(
      parent,
      parentStats,
      `Directory parent changed during cleanup: ${parent}`,
      () => {
        const current = lstatIfExists(name);
        if (
          !current?.isDirectory() ||
          current.isSymbolicLink() ||
          !hasSameFileIdentity(current, expectedIdentity)
        ) {
          return null;
        }
        let empty;
        try {
          empty = readdirSync(name).length === 0;
        } catch {
          return null;
        }
        const beforeRemoval = lstatIfExists(name);
        if (!empty || !hasSameFileIdentity(beforeRemoval, expectedIdentity)) return null;
        try {
          rmdirSync(name);
        } catch {
          return null;
        }
        return { identity: parentStats, path: parent };
      },
    );
  } catch {
    return null;
  }
}

function removeCreatedDirectories(createdDirectories) {
  for (const created of [...createdDirectories].reverse()) {
    removeEmptyDirectoryThroughParent(created.path, created.identity);
  }
}

function ensureTargetParentDirectories(root, targetPath, rootIdentity) {
  const createdDirectories = [];
  const segments = dirname(targetPath).split("/").filter((segment) => segment !== ".");
  let current = root;
  let currentStats = rootIdentity;
  if (!currentStats?.isDirectory() || currentStats.isSymbolicLink()) {
    throw new GuidanceError(`Project root changed while creating generated directories: ${root}`);
  }

  try {
    for (const segment of segments) {
      const next = join(current, segment);
      const currentDisplay = relative(root, current).split(sep).join("/") || ".";
      const { created, nextStats } = withStableDirectory(
        current,
        currentStats,
        `Generated directory changed while parents were being created: ${currentDisplay}`,
        () => {
          let childStats = lstatIfExists(segment);
          let childCreated = false;
          if (!childStats) {
            try {
              mkdirSync(segment);
              childCreated = true;
            } catch (error) {
              if (!error || typeof error !== "object" || error.code !== "EEXIST") {
                throw new GuidanceError(
                  `Could not create generated directory: ${relative(root, next).split(sep).join("/")}`,
                  { cause: error },
                );
              }
            }
            childStats = lstatIfExists(segment);
          }
          if (childStats?.isSymbolicLink()) {
            throw new GuidanceError(
              `generated path traverses a symlink: ${relative(root, next).split(sep).join("/")}`,
            );
          }
          if (!childStats?.isDirectory()) {
            throw new GuidanceError(
              `generated path traverses a non-directory: ${relative(root, next).split(sep).join("/")}`,
            );
          }
          const currentParent = lstatIfExists(current);
          if (
            !currentParent?.isDirectory() ||
            currentParent.isSymbolicLink() ||
            !hasSameFileIdentity(currentParent, currentStats)
          ) {
            if (
              childCreated &&
              hasSameFileIdentity(lstatIfExists(segment), childStats) &&
              readdirSync(segment).length === 0
            ) {
              rmdirSync(segment);
            }
            throw new GuidanceError(
              `Generated directory changed while parents were being created: ${currentDisplay}`,
            );
          }
          return { created: childCreated, nextStats: childStats };
        },
      );
      if (created) {
        createdDirectories.push({
          identity: { dev: nextStats.dev, ino: nextStats.ino },
          path: next,
        });
      }
      current = next;
      currentStats = nextStats;
    }
    return createdDirectories;
  } catch (error) {
    removeCreatedDirectories(createdDirectories);
    throw error;
  }
}

function hasOwnedMarkerForPath(contents, relativePath) {
  const normalized = normalizeLineEndings(contents);
  let header = normalized;
  const cursorPrefix = `${SCOPED_ADAPTERS.cursor.namespace}/`;
  const copilotPrefix = `${SCOPED_ADAPTERS.copilot.namespace}/`;
  if (relativePath === TARGET_PATHS.cursor) {
    const preamble = cursorPreamble();
    if (!header.startsWith(preamble)) return false;
    header = header.slice(preamble.length);
  } else if (relativePath.startsWith(cursorPrefix) && relativePath.endsWith(".mdc")) {
    const frontmatter = /^---\ndescription: ([^\n]+)\nglobs: ([^\n]+)\nalwaysApply: false\n---\n\n/u.exec(
      header,
    );
    if (!frontmatter) return false;
    try {
      const description = JSON.parse(frontmatter[1]);
      const globs = JSON.parse(frontmatter[2]);
      if (
        typeof description !== "string" ||
        !description ||
        !Array.isArray(globs) ||
        globs.length === 0 ||
        globs.some((glob) => typeof glob !== "string" || !glob)
      ) {
        return false;
      }
    } catch {
      return false;
    }
    header = header.slice(frontmatter[0].length);
  } else if (
    relativePath.startsWith(copilotPrefix) &&
    relativePath.endsWith(".instructions.md")
  ) {
    const frontmatter = /^---\napplyTo: ([^\n]+)\n---\n\n/u.exec(header);
    if (!frontmatter) return false;
    try {
      const applyTo = JSON.parse(frontmatter[1]);
      if (typeof applyTo !== "string" || !applyTo) return false;
    } catch {
      return false;
    }
    header = header.slice(frontmatter[0].length);
  }
  const markerLine = header.split("\n", 1)[0];
  const match = /^<!-- agent-guidance-sync:generated:v([0-9]+) source="([^"]+)" target="([^"]+)" -->$/u.exec(
    markerLine,
  );
  if (
    !match ||
    match[1] !== String(GENERATED_FORMAT_VERSION) ||
    match[3] !== relativePath
  ) {
    return false;
  }
  const sourcePath = match[2];
  if (Object.values(TARGET_PATHS).includes(relativePath)) return sourcePath === SOURCE_PATH;
  if (relativePath.startsWith(cursorPrefix) && relativePath.endsWith(".mdc")) {
    const stem = relativePath.slice(cursorPrefix.length, -".mdc".length);
    return sourcePath === `${RULES_PATH}/${stem}.md`;
  }
  if (relativePath.startsWith(copilotPrefix) && relativePath.endsWith(".instructions.md")) {
    const stem = relativePath.slice(copilotPrefix.length, -".instructions.md".length);
    return sourcePath === `${RULES_PATH}/${stem}.md`;
  }
  return false;
}

function deletionItem(relativePath, originalContents, stats) {
  return {
    action: "delete",
    contents: null,
    originalContents,
    originalIdentity: { dev: stats.dev, ino: stats.ino },
    relativePath,
  };
}

function classifyDisabledOwnedTargets(root, rootIdentity, expectedPaths) {
  const obsolete = [];
  for (const relativePath of Object.values(TARGET_PATHS)) {
    if (expectedPaths.has(relativePath)) continue;
    const issue = parentPathIssue(root, relativePath);
    if (issue) continue;
    const path = absoluteTargetPath(root, relativePath);
    const parent = dirname(path);
    const parentStats = parent === root ? rootIdentity : lstatIfExists(parent);
    if (!parentStats) continue;
    if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
      throw new GuidanceError(`${relativePath} parent changed while guidance was being planned.`);
    }
    withStableDirectory(
      parent,
      parentStats,
      `${relativePath} parent changed while guidance was being planned.`,
      () => {
        const targetName = basename(path);
        const stats = lstatIfExists(targetName);
        if (!stats?.isFile() || stats.isSymbolicLink()) return;
        const contents = readStableRegularFile(
          targetName,
          stats,
          `generated target ${relativePath}`,
          path,
        );
        if (hasOwnedMarkerForPath(contents, relativePath)) {
          obsolete.push(deletionItem(relativePath, contents, stats));
        }
      },
    );
  }
  return obsolete;
}

function classifyManagedRuleNamespaces(root, expectedPaths) {
  const items = [];
  const visit = (directoryName, directoryPath, relativeDirectory, expectedStats) => {
    withStableDirectory(
      directoryName,
      expectedStats,
      `Managed output directory changed while being read: ${directoryPath}`,
      () => {
        const entries = readdirSync(".").sort();
        for (const name of entries) {
          const path = join(directoryPath, name);
          const relativePath = `${relativeDirectory}/${name}`;
          const stats = lstatIfExists(name);
          if (!stats) {
            throw new GuidanceError(`Managed output changed while being discovered: ${path}`);
          }
          if (stats.isSymbolicLink()) {
            if (!expectedPaths.has(relativePath)) {
              items.push({
                action: "unsafe",
                contents: null,
                originalContents: null,
                originalIdentity: null,
                reason: "reserved generated namespace contains a symlink",
                relativePath,
              });
            }
            continue;
          }
          if (stats.isDirectory()) {
            visit(name, path, relativePath, stats);
            assertDirectoryStable(name, stats, "Managed output directory", path);
            assertDirectoryStable(
              ".",
              expectedStats,
              "Managed output directory",
              directoryPath,
            );
            continue;
          }
          if (expectedPaths.has(relativePath)) continue;
          if (!stats.isFile()) {
            items.push({
              action: "unsafe",
              contents: null,
              originalContents: null,
              originalIdentity: null,
              reason: "reserved generated namespace contains a non-regular file",
              relativePath,
            });
            continue;
          }
          const contents = readStableRegularFile(
            name,
            stats,
            `managed output ${relativePath}`,
            path,
          );
          if (hasOwnedMarkerForPath(contents, relativePath)) {
            items.push(deletionItem(relativePath, contents, stats));
          } else {
            items.push({
              action: "conflict",
              contents: null,
              originalContents: contents,
              originalIdentity: { dev: stats.dev, ino: stats.ino },
              reason:
                "unmanaged file is inside a reserved generated namespace; move or remove it explicitly",
              relativePath,
            });
          }
        }
        assertDirectoryStable(
          ".",
          expectedStats,
          "Managed output directory",
          directoryPath,
        );
        const currentEntries = readdirSync(".").sort();
        if (
          entries.length !== currentEntries.length ||
          entries.some((entry, index) => entry !== currentEntries[index])
        ) {
          throw new GuidanceError(
            `Managed output directory changed while being read: ${directoryPath}`,
          );
        }
      },
    );
  };

  for (const { namespace: relativeNamespace, targetPath } of Object.values(SCOPED_ADAPTERS)) {
    const adapterEnabled = expectedPaths.has(targetPath);
    const issue = parentPathIssue(root, `${relativeNamespace}/.ownership-probe`);
    if (issue) {
      if (!adapterEnabled) continue;
      items.push({
        action: "unsafe",
        contents: null,
        originalContents: null,
        originalIdentity: null,
        reason: issue,
        relativePath: relativeNamespace,
      });
      continue;
    }
    const namespacePath = absoluteTargetPath(root, relativeNamespace);
    const stats = lstatIfExists(namespacePath);
    if (!stats) continue;
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      items.push({
        action: "unsafe",
        contents: null,
        originalContents: null,
        originalIdentity: null,
        reason: stats.isSymbolicLink()
          ? "reserved generated namespace is a symlink"
          : "reserved generated namespace is not a directory",
        relativePath: relativeNamespace,
      });
      continue;
    }
    visit(namespacePath, namespacePath, relativeNamespace, stats);
    assertDirectoryStable(namespacePath, stats, "Managed output directory");
  }
  return items;
}

function classifyTarget(root, rootIdentity, target, takeover) {
  const issue = parentPathIssue(root, target.relativePath);
  if (issue) {
    return {
      ...target,
      action: "unsafe",
      reason: issue,
      originalContents: null,
      originalIdentity: null,
    };
  }

  const path = absoluteTargetPath(root, target.relativePath);
  const parent = dirname(path);
  const parentStats = parent === root ? rootIdentity : lstatIfExists(parent);
  if (!parentStats) {
    return { ...target, action: "create", originalContents: null, originalIdentity: null };
  }
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
    throw new GuidanceError(
      `${target.relativePath} parent changed while guidance was being planned.`,
    );
  }
  return withStableDirectory(
    parent,
    parentStats,
    `${target.relativePath} parent changed while guidance was being planned.`,
    () => {
      const targetName = basename(path);
      const stats = lstatIfExists(targetName);
      if (!stats) {
        return { ...target, action: "create", originalContents: null, originalIdentity: null };
      }
      if (stats.isSymbolicLink()) {
        return {
          ...target,
          action: "unsafe",
          reason: "generated target is a symlink",
          originalContents: null,
          originalIdentity: null,
        };
      }
      if (!stats.isFile()) {
        return {
          ...target,
          action: "unsafe",
          reason: "generated target is not a regular file",
          originalContents: null,
          originalIdentity: null,
        };
      }

      const originalContents = readStableRegularFile(
        targetName,
        stats,
        `generated target ${target.relativePath}`,
        path,
      );
      const originalIdentity = { dev: stats.dev, ino: stats.ino };
      if (hasOwnedMarkerForPath(originalContents, target.relativePath)) {
        return {
          ...target,
          action: originalContents === target.contents ? "unchanged" : "update",
          originalContents,
          originalIdentity,
        };
      }
      if (takeover === "force") {
        return { ...target, action: "replace", originalContents, originalIdentity };
      }
      if (takeover === "adopt" && originalContents === target.unmanagedContents) {
        return { ...target, action: "adopt", originalContents, originalIdentity };
      }

      return {
        ...target,
        action: "conflict",
        reason:
          takeover === "adopt"
            ? "unmanaged content differs from the generated payload"
            : originalContents === target.unmanagedContents
              ? "unmanaged content matches; use --adopt to claim it"
              : "unmanaged content differs; use --force to replace it",
        originalContents,
        originalIdentity,
      };
    },
  );
}

function assertDirectoryStable(path, expectedStats, label, displayPath = path) {
  const current = lstatIfExists(path);
  if (
    !current?.isDirectory() ||
    current.isSymbolicLink() ||
    !hasSameFileIdentity(current, expectedStats) ||
    current.mtimeMs !== expectedStats.mtimeMs ||
    current.ctimeMs !== expectedStats.ctimeMs
  ) {
    throw new GuidanceError(
      `${label} changed while canonical guidance was being read: ${displayPath}`,
    );
  }
}

function readCanonicalRules(agentsPath) {
  const rulesPath = join(agentsPath, "rules");
  const rootStats = lstatIfExists("rules");
  if (!rootStats) return [];
  if (rootStats.isSymbolicLink()) {
    throw new GuidanceError(`Canonical rules directory must not be a symlink: ${rulesPath}`);
  }
  if (!rootStats.isDirectory()) {
    throw new GuidanceError(`Canonical rules path is not a directory: ${rulesPath}`);
  }

  const ruleFiles = [];
  const visit = (directoryName, relativeDirectory, expectedStats) => {
    const directoryPath = relativeDirectory ? join(rulesPath, relativeDirectory) : rulesPath;
    withStableDirectory(
      directoryName,
      expectedStats,
      `Canonical rules directory changed while canonical guidance was being read: ${directoryPath}`,
      () => {
        const entries = readdirSync(".").sort();
        for (const name of entries) {
          const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
          const path = join(rulesPath, relativePath);
          const stats = lstatIfExists(name);
          if (!stats) {
            throw new GuidanceError(`Canonical rule changed while being discovered: ${path}`);
          }
          if (stats.isSymbolicLink()) {
            throw new GuidanceError(`Canonical rules must not contain symlinks: ${path}`);
          }
          if (stats.isDirectory()) {
            if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) {
              throw new GuidanceError(
                `Canonical rule directories must use lowercase kebab-case: ${relativePath}`,
              );
            }
            visit(name, relativePath, stats);
            assertDirectoryStable(name, stats, "Canonical rules directory", path);
            assertDirectoryStable(
              ".",
              expectedStats,
              "Canonical rules directory",
              directoryPath,
            );
            continue;
          }
          if (!stats.isFile()) {
            throw new GuidanceError(`Canonical rule is not a regular file: ${path}`);
          }
          if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u.test(name)) continue;
          validateRuleRelativePath(relativePath);
          ruleFiles.push({
            contents: readStableRegularFile(
              name,
              stats,
              `canonical rule ${relativePath}`,
              path,
            ),
            relativePath,
          });
        }
        assertDirectoryStable(
          ".",
          expectedStats,
          "Canonical rules directory",
          directoryPath,
        );
        const currentEntries = readdirSync(".").sort();
        if (
          entries.length !== currentEntries.length ||
          entries.some((entry, index) => entry !== currentEntries[index])
        ) {
          throw new GuidanceError(
            `Canonical rules directory changed while canonical guidance was being read: ${directoryPath}`,
          );
        }
      },
    );
  };

  visit("rules", "", rootStats);
  assertDirectoryStable("rules", rootStats, "Canonical rules directory", rulesPath);
  return ruleFiles;
}

function readCanonicalProject(root) {
  const source = inspectCanonicalSource(root);
  if (!source.found) {
    throw new GuidanceError(`Missing canonical source: ${join(root, SOURCE_PATH)}`);
  }

  const assertSourceDirectoryIdentity = () => {
    const currentAgents = lstatIfExists(source.agentsPath);
    if (
      !currentAgents?.isDirectory() ||
      currentAgents.isSymbolicLink() ||
      !hasSameFileIdentity(currentAgents, source.agentsStats)
    ) {
      throw new GuidanceError(
        `Canonical source directory changed while guidance was being read: ${source.agentsPath}`,
      );
    }
  };

  assertSourceDirectoryIdentity();
  const { configContents, guideContents, ruleFiles } = withStableDirectory(
    source.agentsPath,
    source.agentsStats,
    `Canonical source directory changed while guidance was being read: ${source.agentsPath}`,
    () => {
      const guideContents = readStableRegularFile(
        "guide.md",
        source.sourceStats,
        "canonical source",
        source.sourcePath,
      );
      const configPath = join(root, CONFIG_PATH);
      const configStats = lstatIfExists("config.yaml");
      if (!configStats) {
        throw new GuidanceError(
          `Missing canonical config: ${configPath}. Run agent-guidance init to create it without overwriting existing canonical files.`,
        );
      }
      if (configStats.isSymbolicLink()) {
        throw new GuidanceError(`Canonical config must not be a symlink: ${configPath}`);
      }
      if (!configStats.isFile()) {
        throw new GuidanceError(`Canonical config is not a regular file: ${configPath}`);
      }
      const configContents = readStableRegularFile(
        "config.yaml",
        configStats,
        "canonical config",
        configPath,
      );
      const ruleFiles = readCanonicalRules(source.agentsPath);
      assertDirectoryStable(
        ".",
        source.agentsStats,
        "Canonical source directory",
        source.agentsPath,
      );
      return { configContents, guideContents, ruleFiles };
    },
  );
  assertSourceDirectoryIdentity();
  return {
    config: parseConfig(configContents),
    guideContents,
    rules: ruleFiles.map(({ contents, relativePath }) => parseRule(contents, relativePath)),
  };
}

function renderCanonicalTargets(root) {
  const canonical = readCanonicalProject(root);
  return renderTargets(canonical.guideContents, {
    adapters: canonical.config.adapters,
    rules: canonical.rules,
  });
}

function planProjectWithRootIdentity(projectRoot, rootStats, takeover) {
  assertProjectRootUnchanged(projectRoot, rootStats, "while guidance was being planned");
  const targets = renderCanonicalTargets(projectRoot);
  assertProjectRootUnchanged(projectRoot, rootStats, "while guidance was being planned");
  const expectedPaths = new Set(targets.map(({ relativePath }) => relativePath));
  const plan = [
    ...targets.map((target) => classifyTarget(projectRoot, rootStats, target, takeover)),
    ...classifyDisabledOwnedTargets(projectRoot, rootStats, expectedPaths),
    ...classifyManagedRuleNamespaces(projectRoot, expectedPaths),
  ];
  assertProjectRootUnchanged(projectRoot, rootStats, "while guidance was being planned");
  return plan;
}

export function planProject(root, { takeover = "none" } = {}) {
  if (!["none", "adopt", "force"].includes(takeover)) {
    throw new GuidanceError(`Unsupported takeover mode: ${takeover}`);
  }
  const projectRoot = resolve(root);
  const rootStats = lstatIfExists(projectRoot);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
    throw new GuidanceError(`Project root must be a real directory: ${projectRoot}`);
  }
  return planProjectWithRootIdentity(projectRoot, rootStats, takeover);
}

function assertTargetAtPathUnchanged(path, item) {
  const stats = lstatIfExists(path);
  if (item.originalContents === null) {
    if (stats) {
      throw new GuidanceError(`${item.relativePath} changed while guidance was being planned.`);
    }
    return;
  }
  if (!stats?.isFile() || stats.isSymbolicLink()) {
    throw new GuidanceError(`${item.relativePath} changed while guidance was being planned.`);
  }
  if (!hasSameFileIdentity(stats, item.originalIdentity)) {
    throw new GuidanceError(`${item.relativePath} changed while guidance was being planned.`);
  }
  if (readStableRegularFile(path, stats, `generated target ${item.relativePath}`) !== item.originalContents) {
    throw new GuidanceError(`${item.relativePath} changed while guidance was being planned.`);
  }
}

function assertTargetUnchanged(root, rootIdentity, item) {
  const issue = parentPathIssue(root, item.relativePath);
  if (issue) throw new GuidanceError(`${item.relativePath}: ${issue}`);
  const path = absoluteTargetPath(root, item.relativePath);
  const parent = dirname(path);
  const parentStats = parent === root ? rootIdentity : lstatIfExists(parent);
  if (!parentStats) {
    if (item.originalContents !== null) {
      throw new GuidanceError(`${item.relativePath} changed while guidance was being planned.`);
    }
    return;
  }
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
    throw new GuidanceError(`${item.relativePath} changed while guidance was being planned.`);
  }
  withStableDirectory(
    parent,
    parentStats,
    `${item.relativePath} parent changed while guidance was being planned.`,
    () => assertTargetAtPathUnchanged(basename(path), item),
  );
}

function temporaryFileIsOriginal(staged, path = staged.temporaryPath) {
  const stats = lstatIfExists(path);
  return Boolean(
    stats?.isFile() &&
      !stats.isSymbolicLink() &&
      stats.dev === staged.temporaryIdentity.dev &&
      stats.ino === staged.temporaryIdentity.ino,
  );
}

function assertStagedFileUnchanged(staged, path, message) {
  const stats = lstatIfExists(path);
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    !hasSameFileIdentity(stats, staged.temporaryIdentity)
  ) {
    throw new GuidanceError(message);
  }

  let contents;
  try {
    contents = readStableRegularFile(
      path,
      stats,
      `staged temporary file for ${staged.item.relativePath}`,
    );
  } catch (error) {
    throw new GuidanceError(message, { cause: error });
  }
  if (contents !== staged.item.contents) {
    throw new GuidanceError(message);
  }
}

function removeStagedTemporary(staged) {
  try {
    if (temporaryFileIsOriginal(staged)) {
      rmSync(staged.temporaryPath, { force: true });
    }
  } catch {
    // Preserve the owning staging/publication failure; cleanup is best-effort.
  }
}

function removeStagedTemporaryOrThrow(staged) {
  removeStagedTemporary(staged);
  if (temporaryFileIsOriginal(staged)) {
    throw new GuidanceError(
      `Could not remove staged temporary file for ${staged.item.relativePath}.`,
    );
  }
}

function stageAtomicWrite(root, item, rootIdentity) {
  assertProjectRootUnchanged(root, rootIdentity, "before guidance was staged");
  assertTargetUnchanged(root, rootIdentity, item);
  assertProjectRootUnchanged(root, rootIdentity, "before guidance was staged");
  const path = absoluteTargetPath(root, item.relativePath);
  const parent = dirname(path);
  const createdDirectories = ensureTargetParentDirectories(root, item.relativePath, rootIdentity);
  assertProjectRootUnchanged(root, rootIdentity, "while guidance was being staged");
  const issue = parentPathIssue(root, item.relativePath);
  if (issue) {
    removeCreatedDirectories(createdDirectories);
    throw new GuidanceError(`${item.relativePath}: ${issue}`);
  }

  const parentStats = parent === root ? rootIdentity : lstatIfExists(parent);
  if (!parentStats?.isDirectory() || parentStats.isSymbolicLink()) {
    removeCreatedDirectories(createdDirectories);
    throw new GuidanceError(`${item.relativePath}: generated parent is not a real directory`);
  }
  const targetName = basename(path);
  const temporaryName = `.${targetName}.${process.pid}.${randomUUID()}.tmp`;
  const temporaryPath = join(parent, temporaryName);
  try {
    return withStableDirectory(
      parent,
      parentStats,
      `${item.relativePath} parent directory changed while staging.`,
      () => {
        assertProjectRootUnchanged(root, rootIdentity, "while guidance was being staged");
        assertTargetAtPathUnchanged(targetName, item);
        const currentStats = lstatIfExists(targetName);
        const preservedMode = currentStats?.isFile() && !currentStats.isSymbolicLink()
          ? currentStats.mode & 0o777
          : null;
        let temporaryCreated = false;
        let temporaryDescriptor = null;
        let temporaryIdentity = null;
        try {
          temporaryDescriptor = openSync(temporaryName, "wx", preservedMode ?? 0o666);
          temporaryCreated = true;
          temporaryIdentity = fstatSync(temporaryDescriptor);
          writeFileSync(temporaryDescriptor, item.contents, "utf8");
          if (preservedMode !== null) fchmodSync(temporaryDescriptor, preservedMode);
          fsyncSync(temporaryDescriptor);
          closeSync(temporaryDescriptor);
          temporaryDescriptor = null;

          assertTargetAtPathUnchanged(targetName, item);
          const staged = {
            committed: false,
            createdDirectories,
            item,
            parent,
            parentIdentity: parentStats,
            path,
            targetName,
            temporaryIdentity,
            temporaryName,
            temporaryPath,
          };
          assertStagedFileUnchanged(
            staged,
            temporaryName,
            `${item.relativePath} temporary file changed while being staged.`,
          );
          assertProjectRootUnchanged(root, rootIdentity, "while guidance was being staged");
          const currentParent = lstatIfExists(parent);
          if (
            !currentParent?.isDirectory() ||
            currentParent.isSymbolicLink() ||
            !hasSameFileIdentity(currentParent, parentStats)
          ) {
            if (temporaryFileIsOriginal(staged, temporaryName)) {
              rmSync(temporaryName, { force: true });
            }
            throw new GuidanceError(
              `${item.relativePath} parent directory changed while staging.`,
            );
          }
          return staged;
        } catch (error) {
          if (temporaryDescriptor !== null) {
            try {
              closeSync(temporaryDescriptor);
            } catch {
              // Preserve the original failure; cleanup remains best-effort.
            }
          }
          if (temporaryCreated && temporaryIdentity) {
            try {
              const currentTemporary = lstatIfExists(temporaryName);
              if (
                currentTemporary?.isFile() &&
                !currentTemporary.isSymbolicLink() &&
                currentTemporary.dev === temporaryIdentity.dev &&
                currentTemporary.ino === temporaryIdentity.ino
              ) {
                rmSync(temporaryName, { force: true });
              }
            } catch {
              // Preserve the original failure; cleanup remains best-effort.
            }
          }
          throw error;
        }
      },
    );
  } catch (error) {
    removeCreatedDirectories(createdDirectories);
    throw new GuidanceError(`Could not stage atomic write for ${item.relativePath}.`, {
      cause: error,
    });
  }
}

function commitStagedWrite(root, staged, rootIdentity) {
  const { item, parent, parentIdentity, targetName, temporaryName } = staged;
  assertProjectRootUnchanged(root, rootIdentity, "before guidance was published");
  try {
    withStableDirectory(
      parent,
      parentIdentity,
      `${item.relativePath} parent directory changed before publication.`,
      () => {
        assertProjectRootUnchanged(root, rootIdentity, "before guidance was published");
        assertTargetAtPathUnchanged(targetName, item);
        assertStagedFileUnchanged(
          staged,
          temporaryName,
          `${item.relativePath} temporary file changed before publication.`,
        );

        if (item.originalContents === null) {
          linkSync(temporaryName, targetName);
          staged.committed = true;
          const published = lstatIfExists(targetName);
          if (
            !published?.isFile() ||
            published.isSymbolicLink() ||
            !hasSameFileIdentity(published, staged.temporaryIdentity)
          ) {
            throw new GuidanceError(`${item.relativePath} changed during publication.`);
          }
          try {
            assertStagedFileUnchanged(
              staged,
              targetName,
              `${item.relativePath} contents changed during publication.`,
            );
            assertProjectRootUnchanged(root, rootIdentity, "while guidance was being published");
            const currentParent = lstatIfExists(parent);
            if (
              !currentParent?.isDirectory() ||
              currentParent.isSymbolicLink() ||
              !hasSameFileIdentity(currentParent, parentIdentity)
            ) {
              throw new GuidanceError(
                `${item.relativePath} parent directory changed during publication.`,
              );
            }
          } catch (error) {
            if (hasSameFileIdentity(lstatIfExists(targetName), staged.temporaryIdentity)) {
              rmSync(targetName);
            }
            if (temporaryFileIsOriginal(staged, temporaryName)) {
              rmSync(temporaryName, { force: true });
            }
            staged.committed = false;
            throw error;
          }
          if (temporaryFileIsOriginal(staged, temporaryName)) {
            rmSync(temporaryName, { force: true });
          }
          if (temporaryFileIsOriginal(staged, temporaryName)) {
            throw new GuidanceError(
              `Could not remove staged temporary file for ${item.relativePath}.`,
            );
          }
          return;
        }
        renameSync(temporaryName, targetName);
        staged.committed = true;
        const published = lstatIfExists(targetName);
        if (
          !published?.isFile() ||
          published.isSymbolicLink() ||
          !hasSameFileIdentity(published, staged.temporaryIdentity)
        ) {
          throw new GuidanceError(`${item.relativePath} changed during publication.`);
        }
        assertStagedFileUnchanged(
          staged,
          targetName,
          `${item.relativePath} contents changed during publication.`,
        );
        assertProjectRootUnchanged(root, rootIdentity, "while guidance was being published");
        const currentParent = lstatIfExists(parent);
        if (
          !currentParent?.isDirectory() ||
          currentParent.isSymbolicLink() ||
          !hasSameFileIdentity(currentParent, parentIdentity)
        ) {
          throw new GuidanceError(
            `${item.relativePath} parent directory changed during publication.`,
          );
        }
      },
    );
  } catch (error) {
    throw new GuidanceError(`Could not atomically publish ${item.relativePath}.`, { cause: error });
  }
}

function commitDeletion(root, item, rootIdentity) {
  assertProjectRootUnchanged(root, rootIdentity, "before obsolete guidance was deleted");
  const path = absoluteTargetPath(root, item.relativePath);
  const targetName = basename(path);
  const targetParent = dirname(path);
  const targetParentStats = targetParent === root ? rootIdentity : lstatIfExists(targetParent);
  if (!targetParentStats?.isDirectory() || targetParentStats.isSymbolicLink()) {
    throw new GuidanceError(`Could not remove obsolete ${item.relativePath}: parent changed.`);
  }
  try {
    withStableDirectory(
      targetParent,
      targetParentStats,
      `${item.relativePath} parent directory changed before deletion.`,
      () => {
        assertProjectRootUnchanged(root, rootIdentity, "before obsolete guidance was deleted");
        assertTargetAtPathUnchanged(targetName, item);
        rmSync(targetName);
      },
    );
    item.committed = true;
    assertProjectRootUnchanged(root, rootIdentity, "while obsolete guidance was being deleted");
    const managedNamespace = Object.values(SCOPED_ADAPTERS)
      .map(({ namespace }) => namespace)
      .find((namespace) => item.relativePath.startsWith(`${namespace}/`));
    if (!managedNamespace) return;
    const namespacePath = absoluteTargetPath(root, managedNamespace);
    const namespaceParent = dirname(namespacePath);
    let current = { identity: targetParentStats, path: targetParent };
    while (current.path !== namespaceParent) {
      const removed = removeEmptyDirectoryThroughParent(current.path, current.identity);
      if (!removed) break;
      current = removed;
    }
  } catch (error) {
    throw new GuidanceError(`Could not remove obsolete ${item.relativePath}.`, { cause: error });
  }
}

function assertCanonicalSourceMatchesPlan(root, rootIdentity, plan) {
  assertProjectRootUnchanged(root, rootIdentity, "while canonical guidance was being verified");
  const currentTargets = renderCanonicalTargets(root);
  assertProjectRootUnchanged(root, rootIdentity, "while canonical guidance was being verified");
  const plannedContents = new Map(
    plan
      .filter((item) => typeof item.contents === "string")
      .map((item) => [item.relativePath, item.contents]),
  );
  if (
    currentTargets.length !== plannedContents.size ||
    currentTargets.some(
      (target) => plannedContents.get(target.relativePath) !== target.contents,
    )
  ) {
    throw new GuidanceError("Canonical source changed while guidance was being synchronized.");
  }
}

function assertTargetsMatchPlan(root, rootIdentity, plan, staged, deletions) {
  assertProjectRootUnchanged(root, rootIdentity, "while generated guidance was being verified");
  const stagedByPath = new Map(
    staged
      .filter((stagedWrite) => stagedWrite.committed)
      .map((stagedWrite) => [stagedWrite.item.relativePath, stagedWrite]),
  );
  for (const item of plan) {
    if (typeof item.contents !== "string") continue;
    const stagedWrite = stagedByPath.get(item.relativePath);
    if (!stagedWrite) {
      if (parentPathIssue(root, item.relativePath)) continue;
      try {
        assertTargetUnchanged(root, rootIdentity, item);
      } catch (error) {
        throw new GuidanceError(
          `${item.relativePath} changed while guidance was being synchronized.`,
          { cause: error },
        );
      }
      continue;
    }
    const {
      item: stagedItem,
      parent,
      parentIdentity,
      targetName,
      temporaryIdentity,
    } = stagedWrite;
    withStableDirectory(
      parent,
      parentIdentity,
      `${stagedItem.relativePath} parent directory changed after publication.`,
      () => {
        assertProjectRootUnchanged(root, rootIdentity, "while generated guidance was being verified");
        const current = lstatIfExists(targetName);
        if (
          !current?.isFile() ||
          current.isSymbolicLink() ||
          !hasSameFileIdentity(current, temporaryIdentity) ||
          readStableRegularFile(
            targetName,
            current,
            `generated target ${stagedItem.relativePath}`,
          ) !== stagedItem.contents
        ) {
          throw new GuidanceError(
            `${stagedItem.relativePath} changed while guidance was being synchronized.`,
          );
        }
      },
    );
  }
  for (const item of deletions) {
    if (!item.committed) continue;
    const issue = parentPathIssue(root, item.relativePath);
    if (!issue && lstatIfExists(absoluteTargetPath(root, item.relativePath))) {
      throw new GuidanceError(
        `${item.relativePath} changed while guidance was being synchronized.`,
      );
    }
  }
  assertProjectRootUnchanged(root, rootIdentity, "while generated guidance was being verified");
}

export function checkProject(root) {
  const projectRoot = resolve(root);
  const plan = planProject(projectRoot);
  return {
    ok: plan.every((item) => item.action === "unchanged"),
    plan,
    root: projectRoot,
  };
}

export function syncProject(root, { takeover = "none" } = {}) {
  if (!["none", "adopt", "force"].includes(takeover)) {
    throw new GuidanceError(`Unsupported takeover mode: ${takeover}`);
  }
  const projectRoot = resolve(root);
  const rootStats = lstatIfExists(projectRoot);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
    throw new GuidanceError(`Project root must be a real directory: ${projectRoot}`);
  }
  const plan = planProjectWithRootIdentity(projectRoot, rootStats, takeover);
  const blocked = plan.filter((item) => ["conflict", "unsafe"].includes(item.action));
  if (blocked.length > 0) {
    return { changed: [], ok: false, plan, root: projectRoot };
  }

  const changed = plan.filter((item) => item.action !== "unchanged");
  for (const item of changed) {
    assertProjectRootUnchanged(projectRoot, rootStats, "before guidance was synchronized");
    assertTargetUnchanged(projectRoot, rootStats, item);
  }
  assertCanonicalSourceMatchesPlan(projectRoot, rootStats, plan);

  const staged = [];
  const deletions = changed.filter((item) => item.action === "delete");
  const writes = changed.filter((item) => item.action !== "delete");
  try {
    for (const item of writes) {
      staged.push(stageAtomicWrite(projectRoot, item, rootStats));
    }
    assertCanonicalSourceMatchesPlan(projectRoot, rootStats, plan);
  } catch (error) {
    for (const stagedWrite of staged) removeStagedTemporary(stagedWrite);
    for (const stagedWrite of [...staged].reverse()) {
      removeCreatedDirectories(stagedWrite.createdDirectories);
    }
    throw error;
  }

  try {
    for (const stagedWrite of staged) {
      commitStagedWrite(projectRoot, stagedWrite, rootStats);
    }
    for (const item of deletions) commitDeletion(projectRoot, item, rootStats);
    assertCanonicalSourceMatchesPlan(projectRoot, rootStats, plan);
    assertTargetsMatchPlan(projectRoot, rootStats, plan, staged, deletions);
  } catch (error) {
    for (const stagedWrite of staged) removeStagedTemporary(stagedWrite);
    for (const stagedWrite of [...staged].reverse()) {
      removeCreatedDirectories(stagedWrite.createdDirectories);
    }
    const committed = [
      ...staged.filter((stagedWrite) => stagedWrite.committed).map(({ item }) => item),
      ...deletions.filter((item) => item.committed),
    ];
    const partialWriteMessage = committed.length > 0
      ? ` Already updated: ${committed.map(({ relativePath }) => relativePath).join(", ")}. Rerun check before retrying.`
      : " No target files were updated.";
    throw new GuidanceError(
      `${error instanceof Error ? error.message : String(error)}${partialWriteMessage}`,
      { cause: error },
    );
  }

  return { changed, ok: true, plan, root: projectRoot };
}
