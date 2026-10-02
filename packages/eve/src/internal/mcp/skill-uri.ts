export const SKILL_URI_PREFIX = "skill://";

export interface ParsedSkillUri {
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

export function isSafeSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    !segment.includes("/") &&
    !segment.includes("\\") &&
    !segment.includes("\0")
  );
}

export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function skillRootUri(skill: string): string {
  return `${SKILL_URI_PREFIX}${encodeURIComponent(skill)}`;
}

export function skillFileUri(skill: string, path: string): string {
  return `${skillRootUri(skill)}/${encodePath(path)}`;
}

// ---------- Skills and files ----------
