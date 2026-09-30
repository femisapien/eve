import { describe, expect, it } from "vitest";

import { gatewayCallMetadata } from "#instrumentation/gateway-call-metadata.js";

describe("gatewayCallMetadata", () => {
  it.each([
    undefined,
    {},
    { gateway: null },
    { gateway: "gateway" },
    { gateway: [] },
    { gateway: new Date() },
    { gateway: { generationId: 42 } },
    { gateway: { generationId: "" } },
    { gateway: { transcripts: { enabled: "true" } } },
    { gateway: { transcripts: true } },
    { gateway: { transcripts: { enabled: false } } },
  ])("ignores absent or invalid Gateway fields: %j", (metadata) => {
    expect(gatewayCallMetadata(metadata)).toBeUndefined();
  });

  it.each([
    [{ generationId: "gen_call" }, { generationId: "gen_call" }],
    [{ transcripts: { enabled: true } }, { transcriptsEnabled: true }],
    [
      { generationId: "gen_call", transcripts: { enabled: true }, privateContent: "sentinel" },
      { generationId: "gen_call", transcriptsEnabled: true },
    ],
    [
      Object.assign(Object.create(null), { generationId: "gen_call" }),
      { generationId: "gen_call" },
    ],
  ])("projects only immutable Gateway join metadata: %j", (gateway, expected) => {
    const metadata = gatewayCallMetadata({ gateway });
    expect(metadata).toEqual(expected);
    expect(Object.isFrozen(metadata)).toBe(true);
  });
});
