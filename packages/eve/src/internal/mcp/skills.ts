import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import type { AgentDescription, AgentSkillDescription } from "#channel/agent-description.js";
import { MAX_SKILL_FILE_BYTES, SkillReadError } from "#channel/skill-files.js";
import {
  type CacheHint,
  type McpJsonObject,
  type McpServer,
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
} from "#compiled/@modelcontextprotocol/server/index.js";
import { z } from "#compiled/zod/index.js";
import { hasFrontmatter, parseFrontmatter } from "#internal/helpers/gray-matter.js";
import { createLogger } from "#internal/logging.js";
import type { McpServerFeature } from "#internal/mcp/streamable-http-server.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import { isSkillEntryFileName, SKILL_ENTRY_FILE_NAME } from "#shared/skill-entry-file.js";

/** SEP-2640 extension identifier. */
export const MCP_SKILLS_EXTENSION = "io.modelcontextprotocol/skills";

/**
 * Cache hint for skill lists and reads. Lists and files are fixed for the
 * life of a deployment, so the only staleness is a new deployment behind the
 * same URL; a minute bounds that. `private`: the channel's auth admitted this
 * caller, so a shared cache must not hand the result to anyone else.
 */
export const MCP_SKILLS_CACHE_HINT = {
  cacheScope: "private",
  ttlMs: 60_000,
} as const satisfies CacheHint;

/** SEP-2640 limits a conforming host must accept; skills over them are not served. */
export const MCP_SKILL_MAX_RESOURCES = 512;
export const MCP_SKILL_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

const SKILL_URI_PREFIX = "skill://";
const DIRECTORY_MIME_TYPE = "inode/directory";
/** Files read concurrently while building one skill entry. */
const READ_CONCURRENCY = 8;

const log = createLogger("mcp.skills");
const warned = new Set<string>();

/** Logs why a skill or file is not served, once per process. */
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  log.warn(message);
}

/** The operations of an agent that the skills surface adapts. */
export interface McpSkillSource {
  describe(): Promise<AgentDescription>;
  readSkill(skill: string, path?: string): Promise<string | Uint8Array>;
}

/**
 * Capabilities the skills feature serves. SEP-2640 requires `resources` next
 * to the extension. `listChanged` and `subscribe` are declared so clients
 * can subscribe through `subscriptions/listen`; within one deployment the
 * skills never change, so no notification is ever sent, and a client that
 * subscribes simply keeps its cache until the deployment does.
 */
export const MCP_SKILLS_CAPABILITIES = {
  resources: { listChanged: true, subscribe: true },
  extensions: { [MCP_SKILLS_EXTENSION]: { directoryRead: true } },
} as const satisfies McpJsonObject;

export interface McpSkillResource {
  readonly uri: string;
  readonly digest: string;
  readonly size: number;
}

/** One `skills/list` entry. */
export interface McpSkillEntry {
  readonly uri: string;
  readonly frontmatter: JsonObject;
  readonly resources: readonly McpSkillResource[];
}

/**
 * An MCP server feature publishing an agent's compiled skills per SEP-2640:
 * `skills/list`, `skills/get`, `resources/list`, `resources/templates/list`,
 * `resources/read`, and `resources/directory/read`, all under `skill://`,
 * plus no-op `resources/subscribe` and `resources/unsubscribe` on the 2025
 * fallback.
 *
 * Pass it in `features` of `createMcpStreamableHttpServer`, which merges
 * {@link MCP_SKILLS_CAPABILITIES} and then calls `register` once per request.
 * The feature owns the server's resource methods (including `resources/list`
 * and `resources/templates/list`, which the `resources` capability obliges):
 * they are set on the low-level server rather than through
 * `McpServer.registerResource`, whose `resources/read` normalizes the URI
 * with `new URL()` (which resolves `..`) before matching. So nothing else may
 * register resources on the same server.
 *
 * Skill reads take no auth or session: every caller the channel admits sees
 * the same skills.
 *
 * What is served:
 *
 * - A skill is served when its entry file reads, fits the 512 KiB file cap,
 *   its served frontmatter meets the Agent Skills format (name rules,
 *   description 1-1024 characters), and the skill stays within SEP-2640's
 *   512 files and 16 MiB. Otherwise it is absent everywhere: `skills/list`,
 *   `skills/get`, `resources/list`, reads, directory reads, and
 *   subscriptions.
 * - A supporting file over the cap is not served: `resources/read` refuses
 *   it, and the skill's `resources` and directory listings leave it out, so
 *   every view of the skill agrees on its files and the rest stays verifiable.
 * - `SKILL.md` is served with frontmatter that SEP-2640 accepts: its `name` is
 *   the skill's name and it has a `description`. Authored frontmatter that
 *   already satisfies that is served byte for byte. Otherwise (flat and
 *   module skills, whose materialized `SKILL.md` has no frontmatter, or a
 *   package whose `name` is missing or differs from its directory) the served
 *   document carries rewritten frontmatter, and `frontmatter` and the digest
 *   describe that served document.
 */
export function createMcpSkillsFeature(source: McpSkillSource): McpServerFeature<unknown> {
  return {
    capabilities: MCP_SKILLS_CAPABILITIES,
    register(server, { era }) {
      // `register` runs once per request, so the catalog is per request.
      const catalog = createSkillCatalog(source);
      registerSkillHandlers(server, catalog);
      if (era === "legacy") registerLegacySubscriptions(server, catalog);
    },
    async filterResourceSubscriptions(uris) {
      const catalog = createSkillCatalog(source);
      const readable: string[] = [];
      for (const uri of uris) {
        if ((await catalog.file(uri)) !== undefined) readable.push(uri);
      }
      return readable;
    },
  };
}

/**
 * The one eligibility rule every surface reads: a skill is served exactly
 * when {@link snapshotSkill} builds it, and a file exactly when that
 * snapshot holds it. Snapshots are memoized for one request, so the lists,
 * gets, reads, and subscriptions of a request agree.
 */
interface SkillCatalog {
  served(): Promise<SkillSnapshot[]>;
  skill(name: string): Promise<SkillSnapshot | undefined>;
  /** The served file a `skill://` URI names, or `undefined`. */
  file(uri: string): Promise<{ readonly path: string; readonly file: SnapshotFile } | undefined>;
}

function createSkillCatalog(source: McpSkillSource): SkillCatalog {
  let skills: Promise<AgentSkillDescription[]> | undefined;
  const snapshots = new Map<string, Promise<SkillSnapshot | undefined>>();
  const listed = async () => await (skills ??= listSkills(source));
  const snapshot = (skill: AgentSkillDescription) => {
    let pending = snapshots.get(skill.name);
    if (pending === undefined) {
      pending = snapshotSkill(source, skill);
      snapshots.set(skill.name, pending);
    }
    return pending;
  };
  const catalog: SkillCatalog = {
    async served() {
      const result: SkillSnapshot[] = [];
      for (const skill of await listed()) {
        const built = await snapshot(skill);
        if (built !== undefined) result.push(built);
      }
      return result;
    },
    async skill(name) {
      const skill = (await listed()).find((entry) => entry.name === name);
      return skill === undefined ? undefined : await snapshot(skill);
    },
    async file(uri) {
      const parsed = parseSkillUri(uri);
      if (parsed?.path === undefined) return undefined;
      const file = (await catalog.skill(parsed.skill))?.files.get(parsed.path);
      return file === undefined ? undefined : { file, path: parsed.path };
    },
  };
  return catalog;
}

function registerSkillHandlers(server: McpServer, catalog: SkillCatalog): void {
  const low = server.server;

  low.setRequestHandler(
    "skills/list",
    { params: z.looseObject({ cursor: z.string().optional() }) },
    async (params) => {
      rejectCursor(params.cursor);
      const skills = (await catalog.served()).map((snapshot) => snapshot.entry);
      return { skills, ...MCP_SKILLS_CACHE_HINT };
    },
  );

  low.setRequestHandler(
    "skills/get",
    { params: z.looseObject({ uri: z.string() }) },
    async (params) => {
      const parsed = parseSkillUri(params.uri);
      const snapshot =
        parsed !== undefined && parsed.path === SKILL_ENTRY_FILE_NAME
          ? await catalog.skill(parsed.skill)
          : undefined;
      if (snapshot === undefined) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown skill: ${params.uri}`, {
          uri: params.uri,
        });
      }
      return { skill: snapshot.entry };
    },
  );

  low.setRequestHandler(
    "resources/directory/read",
    { params: z.looseObject({ uri: z.string(), cursor: z.string().optional() }) },
    async (params) => {
      rejectCursor(params.cursor);
      const parsed = parseSkillUri(params.uri);
      const snapshot = parsed === undefined ? undefined : await catalog.skill(parsed.skill);
      const resources =
        snapshot === undefined || parsed === undefined
          ? undefined
          : listDirectory(parsed.skill, snapshot.files, parsed.path);
      if (resources === undefined) throw new ResourceNotFoundError(params.uri);
      return { resources };
    },
  );

  low.setRequestHandler("resources/list", async (request) => {
    rejectCursor(request.params?.cursor);
    const resources = (await catalog.served()).map((snapshot) => ({
      uri: snapshot.entry.uri,
      name: snapshot.name,
      description: snapshot.description,
      mimeType: mimeTypeFor(SKILL_ENTRY_FILE_NAME),
      size: snapshot.files.get(SKILL_ENTRY_FILE_NAME)?.bytes.byteLength ?? 0,
    }));
    return { resources, ...MCP_SKILLS_CACHE_HINT };
  });

  low.setRequestHandler("resources/templates/list", async (request) => {
    rejectCursor(request.params?.cursor);
    return { resourceTemplates: [], ...MCP_SKILLS_CACHE_HINT };
  });

  low.setRequestHandler("resources/read", async (request) => {
    const uri = request.params?.uri;
    if (typeof uri !== "string") {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, "params.uri must be a string.");
    }
    const served = await catalog.file(uri);
    if (served === undefined) throw new ResourceNotFoundError(uri);
    const { file } = served;
    const mimeType = file.mimeType;
    const contents =
      file.text === undefined
        ? { uri, mimeType, blob: Buffer.from(file.bytes).toString("base64") }
        : { uri, mimeType, text: file.text };
    return { contents: [contents], ...MCP_SKILLS_CACHE_HINT };
  });
}

/**
 * 2025-era clients subscribe with `resources/subscribe`, which the declared
 * `resources.subscribe` obliges. The fallback is stateless and skills never
 * change within a deployment, so subscribing to a served skill file succeeds
 * and never notifies; any other URI is not found.
 * 2026-07-28 clients subscribe through `subscriptions/listen` instead.
 */
function registerLegacySubscriptions(server: McpServer, catalog: SkillCatalog): void {
  for (const method of ["resources/subscribe", "resources/unsubscribe"] as const) {
    server.server.setRequestHandler(method, async (request) => {
      const uri = request.params?.uri;
      if (typeof uri !== "string") {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, "params.uri must be a string.");
      }
      // Only a served skill file can be subscribed to, as on the listen path.
      if (method === "resources/subscribe" && (await catalog.file(uri)) === undefined) {
        throw new ResourceNotFoundError(uri);
      }
      return {};
    });
  }
}

// ---------- URIs ----------

interface ParsedSkillUri {
  readonly skill: string;
  /** File or directory path below the skill root; `undefined` for the root itself. */
  readonly path?: string;
}

/**
 * Parses `skill://<skill>[/<path>]` strictly. Rejected: other schemes, a
 * query or fragment, backslashes, empty segments (so `//` and a trailing
 * `/`), `.` and `..` segments (decoded too), percent-encoded `/`, `\`, or
 * NUL, and malformed percent-encoding. Segments are percent-decoded. The
 * skill must still exist and the path must still be one of its served files;
 * `readSkill` enforces containment again on the filesystem.
 */
export function parseSkillUri(uri: string): ParsedSkillUri | undefined {
  if (!uri.startsWith(SKILL_URI_PREFIX)) return undefined;
  const rest = uri.slice(SKILL_URI_PREFIX.length);
  if (/[?#\\\s]/u.test(rest)) return undefined;
  const segments: string[] = [];
  for (const raw of rest.split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    if (!isSafeSegment(segment)) return undefined;
    segments.push(segment);
  }
  const [skill, ...path] = segments;
  if (skill === undefined) return undefined;
  return path.length === 0 ? { skill } : { skill, path: path.join("/") };
}

function isSafeSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    !segment.includes("/") &&
    !segment.includes("\\") &&
    !segment.includes("\0")
  );
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function skillRootUri(skill: string): string {
  return `${SKILL_URI_PREFIX}${encodeURIComponent(skill)}`;
}

function skillFileUri(skill: string, path: string): string {
  return `${skillRootUri(skill)}/${encodePath(path)}`;
}

// ---------- Skills and files ----------

async function listSkills(source: McpSkillSource): Promise<AgentSkillDescription[]> {
  const { skills } = await source.describe();
  return [...skills]
    .filter((skill) => isSafeSegment(skill.name))
    .sort((left, right) => compare(left.name, right.name));
}

/**
 * The paths a skill serves: its entry file as `SKILL.md`, whatever case it
 * was authored in, and every other listed file as is. `undefined` when the
 * skill has no entry file or more files than SEP-2640 allows.
 */
function servedPaths(skill: AgentSkillDescription): string[] | undefined {
  const paths = new Set<string>();
  let hasEntry = false;
  for (const file of skill.files) {
    if (!file.split("/").every(isSafeSegment)) continue;
    if (!file.includes("/") && isSkillEntryFileName(file)) {
      if (hasEntry) continue;
      hasEntry = true;
      paths.add(SKILL_ENTRY_FILE_NAME);
    } else {
      paths.add(file);
    }
  }
  if (!hasEntry || paths.size > MCP_SKILL_MAX_RESOURCES) return undefined;
  return [...paths].sort(compare);
}

interface ServedFile {
  readonly bytes: Uint8Array;
  /** Set when the file is UTF-8 text without NUL bytes. */
  readonly text?: string;
}

interface EntryDocument extends ServedFile {
  readonly text: string;
  readonly description: string;
  readonly frontmatter: JsonObject;
}

async function readFileWithinCap(
  source: McpSkillSource,
  skill: string,
  path?: string,
): Promise<ServedFile | undefined> {
  let content: string | Uint8Array;
  try {
    content = await source.readSkill(skill, path);
  } catch (error) {
    if (
      error instanceof SkillReadError &&
      (error.code === "too-large" || error.code === "unknown-file")
    ) {
      return undefined;
    }
    throw error;
  }
  const file =
    typeof content === "string"
      ? { bytes: new TextEncoder().encode(content), text: content }
      : { bytes: content };
  return file.bytes.byteLength > MAX_SKILL_FILE_BYTES ? undefined : file;
}

/**
 * Reads a skill's `SKILL.md` as served: verbatim when its frontmatter has the
 * skill's `name` and a string `description`, otherwise with frontmatter
 * rewritten to carry both (see {@link createMcpSkillsFeature}).
 */
async function readEntryDocument(
  source: McpSkillSource,
  skill: AgentSkillDescription,
): Promise<EntryDocument | undefined> {
  if (servedPaths(skill) === undefined) return undefined;
  const raw = await readFileWithinCap(source, skill.name);
  if (raw?.text === undefined) return undefined;
  const parsed = parseFrontmatterJson(raw.text);
  if (parsed === undefined) return undefined;
  if (
    parsed.present &&
    parsed.data.name === skill.name &&
    typeof parsed.data.description === "string"
  ) {
    return conformingEntry({
      bytes: raw.bytes,
      description: parsed.data.description,
      frontmatter: parsed.data,
      text: raw.text,
    });
  }

  const description =
    typeof parsed.data.description === "string" ? parsed.data.description : skill.description;
  const { name: _name, description: _description, ...rest } = parsed.data;
  const text = `---\n${renderFrontmatter({ name: skill.name, description, ...rest })}---\n${parsed.content}`;
  const reparsed = parseFrontmatterJson(text);
  const bytes = new TextEncoder().encode(text);
  if (
    reparsed === undefined ||
    reparsed.data.name !== skill.name ||
    bytes.byteLength > MAX_SKILL_FILE_BYTES
  ) {
    return undefined;
  }
  return conformingEntry({ bytes, description, frontmatter: reparsed.data, text });
}

/** Agent Skills `name`: 1-64 lowercase letters, digits, and single inner hyphens. */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export const MCP_SKILL_NAME_MAX_LENGTH = 64;
export const MCP_SKILL_DESCRIPTION_MAX_LENGTH = 1024;

/**
 * Whether served frontmatter meets the Agent Skills format SEP-2640 requires:
 * a conforming `name` and a non-empty `description` of at most 1024
 * characters. Checked on the document as served, authored or rewritten, so
 * a skill that fails is absent from every surface.
 */
export function isConformingSkillFrontmatter(frontmatter: JsonObject): boolean {
  const { name, description } = frontmatter;
  if (typeof name !== "string" || typeof description !== "string") return false;
  if (Array.from(name).length > MCP_SKILL_NAME_MAX_LENGTH) return false;
  if (!SKILL_NAME_PATTERN.test(name)) return false;
  if (description.trim().length === 0) return false;
  return Array.from(description).length <= MCP_SKILL_DESCRIPTION_MAX_LENGTH;
}

function conformingEntry(entry: EntryDocument): EntryDocument | undefined {
  return isConformingSkillFrontmatter(entry.frontmatter) ? entry : undefined;
}

/**
 * Renders frontmatter as YAML with every key and value in JSON form: JSON is
 * valid YAML flow syntax, so every authored field survives without a YAML
 * serializer, and quoting keeps a name like `true` a string.
 */
function renderFrontmatter(frontmatter: JsonObject): string {
  return Object.entries(frontmatter)
    .map(([key, value]) => {
      const renderedKey = /^[A-Za-z_][A-Za-z0-9_-]*$/u.test(key) ? key : JSON.stringify(key);
      return `${renderedKey}: ${JSON.stringify(value)}\n`;
    })
    .join("");
}

function parseFrontmatterJson(
  text: string,
): { readonly present: boolean; readonly data: JsonObject; readonly content: string } | undefined {
  const present = hasFrontmatter(text);
  let file;
  try {
    file = parseFrontmatter(text);
  } catch {
    return undefined;
  }
  const data = toJsonValue(file.data);
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
  return { content: present ? file.content : text, data: data as JsonObject, present };
}

/**
 * YAML frontmatter as JSON. js-yaml yields plain JSON values plus `Date` for
 * timestamps, which render as ISO strings, as `JSON.stringify` would.
 */
function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => toJsonValue(item) ?? null);
  if (typeof value === "object") {
    const object: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const json = toJsonValue(item);
      // `defineProperty`, not assignment: a `__proto__` key is authored
      // metadata, and assignment would set the prototype and drop it.
      if (json !== undefined) defineJsonMember(object, key, json);
    }
    return object;
  }
  return undefined;
}

function defineJsonMember(object: Record<string, JsonValue>, key: string, value: JsonValue): void {
  Object.defineProperty(object, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

interface SnapshotFile extends ServedFile {
  readonly mimeType: string;
}

interface SkillSnapshot {
  readonly name: string;
  readonly description: string;
  readonly entry: McpSkillEntry;
  /** Served files by path, sorted by path, with the bytes every surface serves. */
  readonly files: ReadonlyMap<string, SnapshotFile>;
}

/** Reads every file of a skill to build its entry. `undefined` when it is not served. */
async function snapshotSkill(
  source: McpSkillSource,
  skill: AgentSkillDescription,
): Promise<SkillSnapshot | undefined> {
  const unserved = (reason: string) => {
    warnOnce(`mcpChannel does not serve the skill "${skill.name}": ${reason}.`);
    return undefined;
  };
  const paths = servedPaths(skill);
  if (paths === undefined) {
    return unserved(`it has no SKILL.md or more than ${MCP_SKILL_MAX_RESOURCES} files`);
  }
  const document = await readEntryDocument(source, skill);
  if (document === undefined) {
    return unserved(
      "its SKILL.md is unreadable, over the file cap, or does not meet the Agent Skills format",
    );
  }
  // Stop reading once the skill is over the limit instead of holding every file first.
  let total = 0;
  const files = await mapWithConcurrency(paths, READ_CONCURRENCY, async (path) => {
    if (total > MCP_SKILL_MAX_TOTAL_BYTES) return undefined;
    const file =
      path === SKILL_ENTRY_FILE_NAME ? document : await readFileWithinCap(source, skill.name, path);
    total += file?.bytes.byteLength ?? 0;
    return file;
  });
  if (total > MCP_SKILL_MAX_TOTAL_BYTES) {
    return unserved(`its files total more than ${MCP_SKILL_MAX_TOTAL_BYTES} bytes`);
  }
  const resources: McpSkillResource[] = [];
  const served = new Map<string, SnapshotFile>();
  for (const [index, file] of files.entries()) {
    const path = paths[index];
    if (path === undefined) continue;
    if (file === undefined) {
      warnOnce(
        `mcpChannel does not serve "${path}" of the skill "${skill.name}": it is unreadable or over ${MAX_SKILL_FILE_BYTES} bytes.`,
      );
      continue;
    }
    served.set(path, { ...file, mimeType: servedMimeType(path, file) });
    resources.push({
      uri: skillFileUri(skill.name, path),
      digest: `sha256:${createHash("sha256").update(file.bytes).digest("hex")}`,
      size: file.bytes.byteLength,
    });
  }
  return {
    name: skill.name,
    description: document.description,
    entry: {
      uri: skillFileUri(skill.name, SKILL_ENTRY_FILE_NAME),
      frontmatter: document.frontmatter,
      resources,
    },
    files: served,
  };
}

/** Direct children of a directory of a served skill; `undefined` if it is not a directory. */
function listDirectory(
  skill: string,
  files: ReadonlyMap<string, SnapshotFile>,
  directory: string | undefined,
): { uri: string; name: string; mimeType: string }[] | undefined {
  const prefix = directory === undefined ? "" : `${directory}/`;
  const children = new Map<string, { uri: string; name: string; mimeType: string }>();
  for (const [path, file] of files) {
    if (!path.startsWith(prefix)) continue;
    const [name, ...below] = path.slice(prefix.length).split("/");
    if (name === undefined || children.has(name)) continue;
    const uri = skillFileUri(skill, `${prefix}${name}`);
    const mimeType = below.length === 0 ? file.mimeType : DIRECTORY_MIME_TYPE;
    children.set(name, { uri, name, mimeType });
  }
  // The skill root is always a directory; any other path is one only if a
  // served file lies below it.
  if (directory !== undefined && children.size === 0) return undefined;
  return [...children.entries()]
    .sort(([left], [right]) => compare(left, right))
    .map(([, child]) => child);
}

// ---------- Helpers ----------

function rejectCursor(cursor: unknown): void {
  // Every list is returned whole, so the server never issues a cursor.
  if (cursor !== undefined) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Unknown cursor.");
  }
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  css: "text/css",
  csv: "text/csv",
  gif: "image/gif",
  htm: "text/html",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript",
  json: "application/json",
  md: "text/markdown",
  mjs: "text/javascript",
  pdf: "application/pdf",
  png: "image/png",
  py: "text/x-python",
  sh: "text/x-shellscript",
  svg: "image/svg+xml",
  ts: "text/typescript",
  txt: "text/plain",
  webp: "image/webp",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
};

/** MIME type by extension; unknown extensions are `application/octet-stream`. */
export function mimeTypeFor(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const extension = dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
  return MIME_TYPES[extension] ?? "application/octet-stream";
}

/** A text file with an unknown extension is `text/plain`, not `application/octet-stream`. */
function servedMimeType(path: string, file: ServedFile): string {
  const mimeType = mimeTypeFor(path);
  return mimeType === "application/octet-stream" && file.text !== undefined
    ? "text/plain"
    : mimeType;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await map(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
