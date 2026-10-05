import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import {
  LiveStepDynamicModelSelectionKey,
  StaticModelReferenceKey,
  AuthKey,
  ChannelInstrumentationKey,
  ContinuationTokenKey,
  InitiatorAuthKey,
  SessionIdKey,
} from "#context/keys.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { buildResolveContext } from "#context/dynamic-resolve-context.js";

const mockLanguageModel = {
  specificationVersion: "v3",
  provider: "custom",
  modelId: "model",
  supportedUrls: {},
  doGenerate: async () => {
    throw new Error("unused");
  },
  doStream: async () => {
    throw new Error("unused");
  },
} as unknown as LanguageModel;

function createCtx(): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(StaticModelReferenceKey, { id: "openai/gpt-5.5" });
  ctx.set(SessionIdKey, "sess-1");
  ctx.set(AuthKey, null);
  ctx.set(InitiatorAuthKey, null);
  ctx.set(ContinuationTokenKey, "token-1");
  return ctx;
}

describe("buildResolveContext", () => {
  it("includes the active agent model", () => {
    const resolveCtx = buildResolveContext(createCtx(), []);

    expect(resolveCtx.model).toEqual({ id: "openai/gpt-5.5", routing: "gateway" });
  });

  it("includes the active model context window when configured", () => {
    const ctx = createCtx();
    ctx.set(StaticModelReferenceKey, { id: "custom/model", contextWindowTokens: 1_000_000 });

    expect(buildResolveContext(ctx, []).model).toEqual({
      id: "custom/model",
      contextWindowTokens: 1_000_000,
      routing: "gateway",
    });
  });

  it("marks source-backed and live provider models as provider-routed", () => {
    const ctx = createCtx();
    ctx.set(StaticModelReferenceKey, {
      id: "codex/gpt-5.5",
      contextWindowTokens: 200_000,
      source: { sourceKind: "module", logicalPath: "agent.ts", sourceId: "agent" },
    });
    expect(buildResolveContext(ctx, []).model).toMatchObject({ routing: "provider" });

    ctx.set(StaticModelReferenceKey, { id: "openai/gpt-5.5" });
    ctx.set(LiveStepDynamicModelSelectionKey, {
      model: mockLanguageModel,
      reference: { id: "custom/model", contextWindowTokens: 1_000_000 },
    });
    expect(buildResolveContext(ctx, []).model).toMatchObject({ routing: "provider" });
  });

  it("includes null before a model is selected", () => {
    const ctx = createCtx();
    ctx.set(StaticModelReferenceKey, null);

    expect(buildResolveContext(ctx, []).model).toBeNull();
  });

  it("includes channel metadata from ChannelInstrumentationKey", () => {
    const ctx = createCtx();
    ctx.set(ChannelKey, { kind: "http" });
    ctx.set(ChannelInstrumentationKey, {
      kind: "channel:slack",
      metadata: { threadTs: "1234.5678", userId: "U123" },
    });

    const resolveCtx = buildResolveContext(ctx, []);

    expect(resolveCtx.channel.continuationToken).toBe("token-1");
    expect(resolveCtx.channel.metadata).toEqual({
      threadTs: "1234.5678",
      userId: "U123",
    });
  });

  it("sets metadata to undefined when ChannelInstrumentationKey is absent", () => {
    const ctx = createCtx();
    ctx.set(ChannelKey, { kind: "http" });

    const resolveCtx = buildResolveContext(ctx, []);

    expect(resolveCtx.channel.metadata).toBeUndefined();
  });

  it("omits continuation token for an ID-only session", () => {
    const ctx = new ContextContainer();
    ctx.set(StaticModelReferenceKey, { id: "openai/gpt-5.5" });
    ctx.set(SessionIdKey, "sess-1");
    ctx.set(AuthKey, null);
    ctx.set(InitiatorAuthKey, null);

    expect(buildResolveContext(ctx, []).channel.continuationToken).toBeUndefined();
  });

  it("sets metadata to empty object when projection has no metadata", () => {
    const ctx = createCtx();
    ctx.set(ChannelKey, { kind: "http" });
    ctx.set(ChannelInstrumentationKey, {
      kind: "http",
      metadata: {},
    });

    const resolveCtx = buildResolveContext(ctx, []);

    expect(resolveCtx.channel.metadata).toEqual({});
  });
});
