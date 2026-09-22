import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import {
  PendingSkillAnnouncementKey,
  dispatchDynamicSkillEvent,
} from "#context/dynamic-skill-lifecycle.js";
import {
  StaticModelReferenceKey,
  DynamicSkillManifestKey,
  SessionIdKey,
  SandboxKey,
} from "#context/keys.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { defineSkill } from "#public/definitions/skill.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedDynamicSkillResolver } from "#runtime/types.js";
import type { SkillPackageDefinition } from "#shared/skill-definition.js";
import {
  MAX_DYNAMIC_SKILL_FILE_BYTES,
  MAX_DYNAMIC_SKILL_MANIFEST_BYTES,
} from "#context/dynamic-skill-limits.js";
import { DynamicSkillSandboxKey } from "#context/dynamic-skill-sandbox.js";

const HOME_PROBE_COMMAND = `printf '%s\\n' "$HOME"`;

function createMockBundle(authoredSkillNames: readonly string[] = []): CompiledBundle {
  return {
    adapterRegistry: undefined as never,
    compiledArtifactsSource: undefined as never,
    graph: undefined as never,
    hookRegistry: undefined as never,
    moduleMap: undefined as never,
    nodeId: undefined,
    resolvedAgent: {
      config: { name: "test-agent" },
      skills: authoredSkillNames.map((name) => ({ name })),
    } as never,
    subagentRegistry: undefined as never,
    toolRegistry: undefined as never,
    turnAgent: undefined as never,
  };
}

function createCtx(authoredSkillNames: readonly string[] = []) {
  const ctx = new ContextContainer();
  const sandbox = mockSandbox({
    commands: {
      [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
    },
  });
  ctx.set(StaticModelReferenceKey, { id: "openai/gpt-5.5" });
  ctx.set(SessionIdKey, "test-session");
  ctx.set(SandboxKey, sandbox.access);
  ctx.set(BundleKey, createMockBundle(authoredSkillNames));
  return { ctx, sandbox };
}

function createResolver(
  slug: string,
  handler: () =>
    | SkillPackageDefinition
    | Record<string, SkillPackageDefinition>
    | null
    | Promise<SkillPackageDefinition | Record<string, SkillPackageDefinition> | null>,
  extensionNamespace?: string,
): ResolvedDynamicSkillResolver {
  return {
    eventNames: ["session.started"],
    events: {
      "session.started": handler,
    },
    exportName: "default",
    extensionNamespace,
    logicalPath: `skills/${slug}.ts`,
    slug,
    sourceId: `skills/${slug}.ts`,
    sourceKind: "module",
  };
}

function makeEvent(): UnstampedMessageStreamEvent {
  return { type: "session.started", data: {} } as UnstampedMessageStreamEvent;
}

function makeSkill(description: string, markdown = description): SkillPackageDefinition {
  return defineSkill({
    description,
    markdown,
  });
}

describe("dispatchDynamicSkillEvent", () => {
  it("rejects an oversized file before copying bytes or changing an existing manifest", async () => {
    const { ctx, sandbox } = createCtx();
    const getSandbox = vi.spyOn(sandbox.access, "get");
    let packageResult = makeSkill("Original policy");
    const resolver = createResolver("policy", () => packageResult);
    const dispatch = () =>
      dispatchDynamicSkillEvent({ ctx, event: makeEvent(), messages: [], resolvers: [resolver] });
    await dispatch();
    const manifest = ctx.get(DynamicSkillManifestKey);
    const announcement = ctx.get(PendingSkillAnnouncementKey);
    const refresh = vi.fn();
    ctx.setVirtualContext(DynamicSkillSandboxKey, { refresh });
    packageResult = defineSkill({
      description: "Replacement policy",
      files: { "asset.bin": new Uint8Array(MAX_DYNAMIC_SKILL_FILE_BYTES + 1) },
      markdown: "Replacement policy",
    });
    const copies = vi.spyOn(Buffer, "from");
    try {
      await expect(dispatch()).rejects.toThrow('file "asset.bin" is 262145 bytes');
      expect(copies).not.toHaveBeenCalled();
    } finally {
      copies.mockRestore();
    }
    expect(ctx.get(DynamicSkillManifestKey)).toBe(manifest);
    expect(ctx.get(PendingSkillAnnouncementKey)).toBe(announcement);
    expect(refresh).not.toHaveBeenCalled();
    expect(getSandbox).not.toHaveBeenCalled();
  });

  it("bounds the combined manifest across unchanged and updated resolvers", async () => {
    const { ctx, sandbox } = createCtx();
    const getSandbox = vi.spyOn(sandbox.access, "get");
    const large = makeSkill("Large policy", "a".repeat(MAX_DYNAMIC_SKILL_FILE_BYTES));
    const original = createResolver("original", () => large);
    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [original],
    });
    const manifest = ctx.get(DynamicSkillManifestKey);
    const announcement = ctx.get(PendingSkillAnnouncementKey);

    await expect(
      dispatchDynamicSkillEvent({
        ctx,
        event: makeEvent(),
        messages: [],
        resolvers: [createResolver("second", () => large)],
      }),
    ).rejects.toThrow("1 MiB");

    expect(ctx.get(DynamicSkillManifestKey)).toBe(manifest);
    expect(ctx.get(PendingSkillAnnouncementKey)).toBe(announcement);
    expect(getSandbox).not.toHaveBeenCalled();

    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [createResolver("second", () => large), createResolver("original", () => null)],
    });
    expect(Object.keys(ctx.require(DynamicSkillManifestKey))).toEqual(["second"]);
    expect(getSandbox).not.toHaveBeenCalled();
  });

  it("allows exactly the serialized manifest limit including resolver and skill array overhead", async () => {
    const { ctx } = createCtx();
    let description = "Policy";
    const resolver = createResolver('tenant"team', () => ({
      policy: makeSkill(description, "Policy"),
      helper: makeSkill("Helper"),
    }));
    const dispatch = () =>
      dispatchDynamicSkillEvent({ ctx, event: makeEvent(), messages: [], resolvers: [resolver] });
    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [createResolver("existing", () => makeSkill("Existing")), resolver],
    });
    const initialBytes = Buffer.byteLength(JSON.stringify(ctx.get(DynamicSkillManifestKey)));
    description += "a".repeat(MAX_DYNAMIC_SKILL_MANIFEST_BYTES - initialBytes);
    await dispatch();
    const manifest = ctx.get(DynamicSkillManifestKey);
    expect(Buffer.byteLength(JSON.stringify(manifest))).toBe(MAX_DYNAMIC_SKILL_MANIFEST_BYTES);
    description += "a";
    await expect(dispatch()).rejects.toThrow("1 MiB");
    expect(ctx.get(DynamicSkillManifestKey)).toBe(manifest);
  });

  it("announces when all dynamic skills are withdrawn", async () => {
    const { ctx, sandbox } = createCtx();
    let enabled = true;
    const resolver = createResolver("tenant", () =>
      enabled ? makeSkill("Tenant policy", "Follow tenant policy.") : null,
    );

    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(ctx.get(PendingSkillAnnouncementKey)).toContain("tenant: Tenant policy");
    expect(ctx.get(DynamicSkillManifestKey)).toMatchObject({
      tenant: [{ description: "Tenant policy", name: "tenant" }],
    });

    enabled = false;
    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(ctx.get(DynamicSkillManifestKey)).toMatchObject({});
    expect(ctx.get(PendingSkillAnnouncementKey)).toBe("Available skills: none");
    expect(sandbox.removedPaths).toEqual([]);

    ctx.clearVirtualContext();
    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [],
    });
    expect(ctx.get(PendingSkillAnnouncementKey)).toBe("Available skills: none");
  });

  it("keeps remaining dynamic skills in the announcement when one resolver removes its skill", async () => {
    const { ctx } = createCtx();
    let tenantEnabled = true;
    const tenant = createResolver("tenant", () =>
      tenantEnabled ? makeSkill("Tenant policy") : null,
    );
    const support = createResolver("support", () => makeSkill("Support policy"));

    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [tenant, support],
    });

    tenantEnabled = false;
    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [tenant, support],
    });

    const announcement = ctx.get(PendingSkillAnnouncementKey);
    expect(announcement).not.toContain("tenant: Tenant policy");
    expect(announcement).toContain("support: Support policy");
  });

  it("names map entries by their bare key", async () => {
    const { ctx, sandbox } = createCtx();
    const resolver = createResolver("custom", () => ({
      "talk-like-a-dog": makeSkill("Talk like a dog", "Woof."),
    }));

    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(ctx.get(DynamicSkillManifestKey)).toMatchObject({
      custom: [{ description: "Talk like a dog", name: "talk-like-a-dog" }],
    });
    expect(ctx.get(PendingSkillAnnouncementKey)).toContain("talk-like-a-dog: Talk like a dog");
    expect(sandbox.writes).toEqual([]);
  });

  it("prefixes map entries with the mount namespace for an extension resolver", async () => {
    const { ctx, sandbox } = createCtx();
    const resolver = createResolver(
      "crm__playbooks",
      () => ({ triage: makeSkill("Triage an account", "Triage.") }),
      "crm",
    );

    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(ctx.get(DynamicSkillManifestKey)).toMatchObject({
      crm__playbooks: [{ description: "Triage an account", name: "crm__triage" }],
    });
    expect(ctx.get(PendingSkillAnnouncementKey)).toContain("crm__triage: Triage an account");
    expect(sandbox.writes).toEqual([]);
  });

  it("lets a dynamic skill override a same-named authored skill instead of throwing", async () => {
    const { ctx, sandbox } = createCtx(["talk-like-a-dog"]);
    const resolver = createResolver("custom", () => ({
      "talk-like-a-dog": makeSkill("Dynamic override", "Woof."),
    }));

    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(ctx.get(DynamicSkillManifestKey)).toMatchObject({
      custom: [{ description: "Dynamic override", name: "talk-like-a-dog" }],
    });
    expect(sandbox.writes).toEqual([]);
  });

  it("collapses a directly-returned single defineSkill to the bare slug", async () => {
    const { ctx, sandbox } = createCtx();
    const resolver = createResolver("tenant", () => makeSkill("Tenant policy"));

    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(ctx.get(DynamicSkillManifestKey)).toMatchObject({
      tenant: [{ description: "Tenant policy", name: "tenant" }],
    });
    expect(sandbox.writes).toEqual([]);
  });

  it("throws and recommends manual namespacing when two resolvers emit the same name", async () => {
    const { ctx, sandbox } = createCtx();
    const alpha = createResolver("alpha", () => ({ shared: makeSkill("From alpha") }));
    const beta = createResolver("beta", () => ({ shared: makeSkill("From beta") }));

    await expect(
      dispatchDynamicSkillEvent({
        ctx,
        event: makeEvent(),
        messages: [],
        resolvers: [alpha, beta],
      }),
    ).rejects.toThrow(/Dynamic skill "shared".*Namespace the map key manually/u);

    expect(sandbox.writes).toEqual([]);
    expect(ctx.get(DynamicSkillManifestKey)).toBeUndefined();
    expect(ctx.get(PendingSkillAnnouncementKey)).toBeUndefined();
  });
});
