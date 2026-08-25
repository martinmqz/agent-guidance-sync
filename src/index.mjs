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
  readFileSync,
  renameSync,
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
export const INITIAL_GUIDE = `# Repository Agent Guidance

Replace this text with the coding-agent instructions that apply throughout this
repository.
`;

const GENERATED_FORMAT_VERSION = 1;
const TARGET_PATHS = Object.freeze({
  agents: "AGENTS.md",
  claude: "CLAUDE.md",
  cursor: ".cursor/rules/agent-guidance.mdc",
  copilot: ".github/copilot-instructions.md",
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

function readStableRegularFile(path, expectedStats, label) {
  let descriptor = null;
  try {
    const noFollowFlag = process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
    descriptor = openSync(path, fsConstants.O_RDONLY | noFollowFlag);
    const openedBefore = fstatSync(descriptor);
    if (!openedBefore.isFile() || !hasSameFileIdentity(openedBefore, expectedStats)) {
      throw new GuidanceError(`${label} changed before it could be read: ${path}`);
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
      throw new GuidanceError(`${label} changed while it was being read: ${path}`);
    }
    return contents;
  } catch (error) {
    if (error instanceof GuidanceError) throw error;
    throw new GuidanceError(`Could not safely read ${label}: ${path}`, { cause: error });
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function normalizeLineEndings(contents) {
  return contents.replace(/\r\n?/gu, "\n");
}

function normalizeGuide(contents) {
  const normalized = normalizeLineEndings(contents);
  if (!normalized.trim()) {
    throw new GuidanceError(`${SOURCE_PATH} must contain non-whitespace guidance.`);
  }
  return `${normalized.replace(/(?:\n[\t ]*)+$/u, "")}\n`;
}

function validateRelativePath(relativePath) {
  if (
    !relativePath ||
    isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
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

export function generatedMarker(targetPath) {
  validateRelativePath(targetPath);
  return `<!-- agent-guidance-sync:generated:v${GENERATED_FORMAT_VERSION} source="${SOURCE_PATH}" target="${targetPath}" -->`;
}

function cursorPreamble() {
  return `---
description: Repository-wide guidance generated from .agents/guide.md
alwaysApply: true
---

`;
}

function renderedTarget(relativePath, unmanagedContents, prefix = "") {
  const marker = generatedMarker(relativePath);
  return {
    relativePath,
    marker,
    ownershipHeader: `${prefix}${marker}`,
    contents: `${prefix}${marker}\n\n${unmanagedContents}`,
    unmanagedContents: `${prefix}${unmanagedContents}`,
  };
}

export function renderTargets(guideContents) {
  const guide = normalizeGuide(guideContents);
  const claudeImport = "@AGENTS.md\n";
  const cursorPrefix = cursorPreamble();

  return [
    renderedTarget(TARGET_PATHS.agents, guide),
    renderedTarget(TARGET_PATHS.claude, claudeImport),
    renderedTarget(TARGET_PATHS.cursor, guide, cursorPrefix),
    renderedTarget(TARGET_PATHS.copilot, guide),
  ];
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

  const agentsPath = join(projectRoot, ".agents");
  let agentsStats = lstatIfExists(agentsPath);
  if (!agentsStats) {
    try {
      mkdirSync(agentsPath, { mode: 0o755 });
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "EEXIST") {
        throw new GuidanceError(`Could not create canonical source directory: ${agentsPath}`, {
          cause: error,
        });
      }
    }
    agentsStats = lstatIfExists(agentsPath);
  }
  if (agentsStats?.isSymbolicLink()) {
    throw new GuidanceError(`Canonical source directory must not be a symlink: ${agentsPath}`);
  }
  if (!agentsStats?.isDirectory()) {
    throw new GuidanceError(`Canonical source path is not a directory: ${agentsPath}`);
  }

  const assertAgentsDirectoryUnchanged = () => {
    const current = lstatIfExists(agentsPath);
    if (
      !current?.isDirectory() ||
      current.isSymbolicLink() ||
      !hasSameFileIdentity(current, agentsStats)
    ) {
      throw new GuidanceError(
        `Canonical source directory changed during initialization: ${agentsPath}`,
      );
    }
  };

  const sourcePath = join(agentsPath, "guide.md");
  const classifyExistingSource = () => {
    const sourceStats = lstatIfExists(sourcePath);
    if (!sourceStats) return null;
    if (sourceStats.isSymbolicLink()) {
      throw new GuidanceError(`Canonical source must not be a symlink: ${sourcePath}`);
    }
    if (!sourceStats.isFile()) {
      throw new GuidanceError(`Canonical source is not a regular file: ${sourcePath}`);
    }
    return { created: false, root: projectRoot, sourcePath };
  };

  assertAgentsDirectoryUnchanged();
  const existing = classifyExistingSource();
  if (existing) return existing;

  const temporaryPath = join(
    agentsPath,
    `.guide.md.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor = null;
  let temporaryIdentity = null;
  const staged = {
    committed: false,
    item: { relativePath: SOURCE_PATH },
    path: sourcePath,
    temporaryIdentity: null,
    temporaryPath,
  };

  try {
    descriptor = openSync(temporaryPath, "wx", 0o666);
    temporaryIdentity = fstatSync(descriptor);
    staged.temporaryIdentity = temporaryIdentity;
    writeFileSync(descriptor, INITIAL_GUIDE, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;

    assertAgentsDirectoryUnchanged();
    if (!temporaryFileIsOriginal(staged)) {
      throw new GuidanceError(`${SOURCE_PATH} temporary file changed during initialization.`);
    }

    const concurrentSource = classifyExistingSource();
    if (concurrentSource) return concurrentSource;

    try {
      linkSync(temporaryPath, sourcePath);
      staged.committed = true;
    } catch (error) {
      if (error && typeof error === "object" && error.code === "EEXIST") {
        const racedSource = classifyExistingSource();
        if (racedSource) return racedSource;
      }
      throw new GuidanceError(`Could not atomically create ${SOURCE_PATH}.`, { cause: error });
    }
    removeStagedTemporaryOrThrow(staged);
    return { created: true, root: projectRoot, sourcePath };
  } catch (error) {
    if (error instanceof GuidanceError) throw error;
    throw new GuidanceError(`Could not initialize ${SOURCE_PATH}.`, { cause: error });
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the initialization failure; cleanup is best-effort.
      }
    }
    if (temporaryIdentity) removeStagedTemporary(staged);
  }
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

function hasExactOwnershipHeader(contents, ownershipHeader) {
  const normalized = normalizeLineEndings(contents);
  return normalized === ownershipHeader || normalized.startsWith(`${ownershipHeader}\n`);
}

function classifyTarget(root, target, takeover) {
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
  const stats = lstatIfExists(path);
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
    path,
    stats,
    `generated target ${target.relativePath}`,
  );
  const originalIdentity = { dev: stats.dev, ino: stats.ino };
  if (hasExactOwnershipHeader(originalContents, target.ownershipHeader)) {
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
}

function readGuide(root) {
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
  const contents = readStableRegularFile(
    source.sourcePath,
    source.sourceStats,
    "canonical source",
  );
  assertSourceDirectoryIdentity();
  return contents;
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
  return renderTargets(readGuide(projectRoot)).map((target) =>
    classifyTarget(projectRoot, target, takeover),
  );
}

function assertTargetUnchanged(root, item) {
  const issue = parentPathIssue(root, item.relativePath);
  if (issue) throw new GuidanceError(`${item.relativePath}: ${issue}`);

  const path = absoluteTargetPath(root, item.relativePath);
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

function temporaryFileIsOriginal(staged) {
  const stats = lstatIfExists(staged.temporaryPath);
  return Boolean(
    stats?.isFile() &&
      !stats.isSymbolicLink() &&
      stats.dev === staged.temporaryIdentity.dev &&
      stats.ino === staged.temporaryIdentity.ino,
  );
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

function stageAtomicWrite(root, item) {
  assertTargetUnchanged(root, item);
  const path = absoluteTargetPath(root, item.relativePath);
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  const issue = parentPathIssue(root, item.relativePath);
  if (issue) throw new GuidanceError(`${item.relativePath}: ${issue}`);

  const currentStats = lstatIfExists(path);
  const preservedMode = currentStats?.isFile() && !currentStats.isSymbolicLink()
    ? currentStats.mode & 0o777
    : null;
  const temporaryPath = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let temporaryCreated = false;
  let temporaryDescriptor = null;
  let temporaryIdentity = null;

  try {
    temporaryDescriptor = openSync(temporaryPath, "wx", preservedMode ?? 0o666);
    temporaryCreated = true;
    temporaryIdentity = fstatSync(temporaryDescriptor);
    writeFileSync(temporaryDescriptor, item.contents, "utf8");
    if (preservedMode !== null) fchmodSync(temporaryDescriptor, preservedMode);
    fsyncSync(temporaryDescriptor);
    closeSync(temporaryDescriptor);
    temporaryDescriptor = null;

    assertTargetUnchanged(root, item);
    const staged = {
      committed: false,
      item,
      path,
      temporaryIdentity,
      temporaryPath,
    };
    if (!temporaryFileIsOriginal(staged)) {
      throw new GuidanceError(`${item.relativePath} temporary file changed while being staged.`);
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
        const currentTemporary = lstatIfExists(temporaryPath);
        if (
          currentTemporary?.isFile() &&
          !currentTemporary.isSymbolicLink() &&
          currentTemporary.dev === temporaryIdentity.dev &&
          currentTemporary.ino === temporaryIdentity.ino
        ) {
          rmSync(temporaryPath, { force: true });
        }
      } catch {
        // Preserve the original failure; cleanup remains best-effort.
      }
    }
    throw new GuidanceError(`Could not stage atomic write for ${item.relativePath}.`, {
      cause: error,
    });
  }
}

function commitStagedWrite(root, staged) {
  const { item, path, temporaryPath } = staged;
  assertTargetUnchanged(root, item);
  if (!temporaryFileIsOriginal(staged)) {
    throw new GuidanceError(`${item.relativePath} temporary file changed before publication.`);
  }

  try {
    if (item.originalContents === null) {
      linkSync(temporaryPath, path);
      staged.committed = true;
      removeStagedTemporaryOrThrow(staged);
      return;
    }
    renameSync(temporaryPath, path);
    staged.committed = true;
  } catch (error) {
    throw new GuidanceError(`Could not atomically publish ${item.relativePath}.`, { cause: error });
  }
}

function assertCanonicalSourceMatchesPlan(root, plan) {
  const currentTargets = renderTargets(readGuide(root));
  const plannedContents = new Map(plan.map((item) => [item.relativePath, item.contents]));
  if (
    currentTargets.some(
      (target) => plannedContents.get(target.relativePath) !== target.contents,
    )
  ) {
    throw new GuidanceError("Canonical source changed while guidance was being synchronized.");
  }
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
  const projectRoot = resolve(root);
  const plan = planProject(projectRoot, { takeover });
  const blocked = plan.filter((item) => ["conflict", "unsafe"].includes(item.action));
  if (blocked.length > 0) {
    return { changed: [], ok: false, plan, root: projectRoot };
  }

  const changed = plan.filter((item) => item.action !== "unchanged");
  for (const item of changed) assertTargetUnchanged(projectRoot, item);
  assertCanonicalSourceMatchesPlan(projectRoot, plan);

  const staged = [];
  try {
    for (const item of changed) staged.push(stageAtomicWrite(projectRoot, item));
    assertCanonicalSourceMatchesPlan(projectRoot, plan);
  } catch (error) {
    for (const stagedWrite of staged) removeStagedTemporary(stagedWrite);
    throw error;
  }

  try {
    for (const stagedWrite of staged) commitStagedWrite(projectRoot, stagedWrite);
  } catch (error) {
    for (const stagedWrite of staged) removeStagedTemporary(stagedWrite);
    const committed = staged.filter((stagedWrite) => stagedWrite.committed);
    const partialWriteMessage = committed.length > 0
      ? ` Already updated: ${committed.map(({ item }) => item.relativePath).join(", ")}. Rerun check before retrying.`
      : " No target files were updated.";
    throw new GuidanceError(
      `${error instanceof Error ? error.message : String(error)}${partialWriteMessage}`,
      { cause: error },
    );
  }

  return { changed, ok: true, plan, root: projectRoot };
}
