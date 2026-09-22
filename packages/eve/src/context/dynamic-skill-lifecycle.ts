import { Buffer } from "node:buffer";

import type { ModelMessage } from "ai";

import { ALLOWED_DYNAMIC_SKILL_EVENTS } from "#dynamic/definition.js";
import { isBrandedSkillEntry, type SkillPackageDefinition } from "#shared/skill-definition.js";
import { normalizeSkillPackage, stripSkillFrontmatter } from "#shared/skill-package.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { ResolvedDynamicSkillResolver } from "#runtime/types.js";
import { formatAvailableSkillsSection } from "#execution/skills/instructions.js";
import { createLogger } from "#internal/logging.js";
import { toErrorMessage } from "#shared/errors.js";
import type { ContextContainer } from "#context/container.js";
import { type DynamicSkillManifest, DynamicSkillManifestKey } from "#context/keys.js";
import { buildResolveContext } from "#context/dynamic-resolve-context.js";
import { DynamicSkillSandboxKey } from "#context/dynamic-skill-sandbox.js";
import {
  assertDynamicSkillManifestSize,
  getDynamicSkillPackageSize,
} from "#context/dynamic-skill-limits.js";

const log = createLogger("dynamic-skills");

// ---------------------------------------------------------------------------
// Name qualification
// ---------------------------------------------------------------------------

function qualifyDynamicSkillNames(
  resolver: { readonly slug: string; readonly extensionNamespace?: string },
  isSingle: boolean,
  entries: Readonly<Record<string, SkillPackageDefinition>>,
): Array<{ name: string; entryKey: string; entry: SkillPackageDefinition }> {
  const keys = Object.keys(entries);
  const result: Array<{ name: string; entryKey: string; entry: SkillPackageDefinition }> = [];

  if (keys.length === 0) return result;

  // A single returned defineSkill is named after the file slug (already
  // namespaced for an extension). A map names each entry by its bare key.
  if (isSingle) {
    result.push({ name: resolver.slug, entryKey: keys[0]!, entry: entries[keys[0]!]! });
    return result;
  }

  // Map entries from an extension resolver are prefixed with the mount
  // namespace so extension-produced skills are namespaced like the extension's
  // static skills; a non-extension resolver's keys stay bare.
  const prefix =
    resolver.extensionNamespace !== undefined ? `${resolver.extensionNamespace}__` : "";
  for (const key of keys) {
    result.push({ name: `${prefix}${key}`, entryKey: key, entry: entries[key]! });
  }
  return result;
}

interface DynamicSkillResolution {
  readonly resolver: ResolvedDynamicSkillResolver;
  readonly named: readonly { name: string; entry: SkillPackageDefinition }[];
}

function formatDynamicSkillAnnouncement(manifest: DynamicSkillManifest): string {
  return formatAvailableSkillsSection(Object.values(manifest).flat()) ?? "Available skills: none";
}

// ---------------------------------------------------------------------------
// Single entry detection
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Context key for pending announcements
// ---------------------------------------------------------------------------

import { ContextKey } from "#context/key.js";

/**
 * Step-local pending skill announcement text. Set by
 * {@link dispatchDynamicSkillEvent} whenever the dynamic skill manifest
 * changes. Read by the tool-loop to inject the announcement into model
 * context.
 */
export const PendingSkillAnnouncementKey = new ContextKey<string>("eve.pendingSkillAnnouncement");

// ---------------------------------------------------------------------------
// Event dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatches a stream event to dynamic skill resolvers. On a matching
 * event: runs handlers, reconciles already materialized skills,
 * retains complete packages, and stores a pending announcement for the
 * tool-loop to inject.
 */
export async function dispatchDynamicSkillEvent(input: {
  readonly ctx: ContextContainer;
  readonly resolvers: readonly ResolvedDynamicSkillResolver[];
  readonly event: UnstampedMessageStreamEvent;
  readonly messages: readonly ModelMessage[];
}): Promise<void> {
  const { ctx, resolvers, event, messages } = input;

  // Build phase: rebuild announcement from durable manifest when the
  // virtual key is empty (step boundary crossed).
  if (ctx.get(PendingSkillAnnouncementKey) === undefined) {
    const manifest = ctx.get(DynamicSkillManifestKey);
    if (manifest !== undefined) {
      ctx.setVirtualContext(PendingSkillAnnouncementKey, formatDynamicSkillAnnouncement(manifest));
    }
  }

  if (!ALLOWED_DYNAMIC_SKILL_EVENTS.has(event.type)) return;

  const matching = resolvers.filter((r) => r.eventNames.includes(event.type));
  if (matching.length === 0) return;

  const resolveCtx = buildResolveContext(ctx, messages);
  const manifest = ctx.get(DynamicSkillManifestKey) ?? {};
  const updates: DynamicSkillResolution[] = [];

  const outcomes = await Promise.allSettled(
    matching.map(async (resolver) => {
      const handler = resolver.events[event.type];
      if (handler === undefined) return null;

      const rawResult = await handler(event, resolveCtx);
      if (rawResult === null || rawResult === undefined) return { resolver, named: [] };

      let entries: Record<string, SkillPackageDefinition>;
      let isSingle: boolean;
      if (isBrandedSkillEntry(rawResult)) {
        entries = { _single: rawResult as SkillPackageDefinition };
        isSingle = true;
      } else {
        entries = rawResult as Record<string, SkillPackageDefinition>;
        isSingle = false;
      }

      const named = qualifyDynamicSkillNames(resolver, isSingle, entries);
      return { resolver, named } satisfies DynamicSkillResolution;
    }),
  );

  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      log.error(`Dynamic skill resolver (${event.type}) threw — skipping.`, {
        error: toErrorMessage(outcome.reason),
      });
      continue;
    }
    if (outcome.value === null) continue;
    updates.push(outcome.value);
  }

  if (updates.length === 0) return;

  const newManifest = { ...manifest };
  for (const { resolver } of updates) delete newManifest[resolver.slug];
  let manifestBytes = Buffer.byteLength(JSON.stringify(newManifest));
  let resolverCount = Object.keys(newManifest).length;
  for (const { resolver, named } of updates) {
    if (named.length === 0) continue;
    assertDynamicSkillManifestSize(Buffer.byteLength(resolver.slug));
    manifestBytes += Buffer.byteLength(JSON.stringify({ [resolver.slug]: [] })) - 2;
    if (resolverCount++ > 0) manifestBytes++;
    assertDynamicSkillManifestSize(manifestBytes);
    newManifest[resolver.slug] = named.map(({ name, entry }, index) => {
      const definition = { ...entry, name };
      manifestBytes += getDynamicSkillPackageSize(definition) + (index > 0 ? 1 : 0);
      assertDynamicSkillManifestSize(manifestBytes);
      const skill = normalizeSkillPackage(definition);
      return {
        description: skill.description,
        files: skill.files.map((file) => ({
          content: file.content.toString("base64"),
          relativePath: file.relativePath,
        })),
        markdown: stripSkillFrontmatter(skill.markdown),
        name: skill.name,
      };
    });
  }

  // Dynamic skills override authored skills, but two dynamic resolvers
  // emitting the same name are ambiguous.
  const dynamicSkillOwners = new Map<string, string>();
  for (const [resolverSlug, skills] of Object.entries(newManifest)) {
    for (const { name } of skills) {
      const previousOwner = dynamicSkillOwners.get(name);
      if (previousOwner !== undefined) {
        throw new Error(
          `Dynamic skill "${name}" from resolver "${resolverSlug}" collides with dynamic resolver "${previousOwner}". Namespace the map key manually, e.g. "${resolverSlug}__${name}".`,
        );
      }
      dynamicSkillOwners.set(name, resolverSlug);
    }
  }

  await ctx.get(DynamicSkillSandboxKey)?.refresh(newManifest);

  ctx.set(DynamicSkillManifestKey, newManifest);
  ctx.setVirtualContext(PendingSkillAnnouncementKey, formatDynamicSkillAnnouncement(newManifest));
}
