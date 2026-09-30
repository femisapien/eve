import type { InstrumentationModelCallCompletedEvent } from "#instrumentation/lifecycle.js";

export function gatewayCallMetadata(
  providerMetadata: unknown,
): InstrumentationModelCallCompletedEvent["gateway"] {
  if (typeof providerMetadata !== "object" || providerMetadata === null) return undefined;
  const gateway = (providerMetadata as Readonly<Record<string, unknown>>)["gateway"];
  if (typeof gateway !== "object" || gateway === null || Array.isArray(gateway)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(gateway);
  if (prototype !== Object.prototype && prototype !== null) return undefined;

  const source = gateway as Readonly<Record<string, unknown>>;
  const generationId = source["generationId"];
  const transcripts = source["transcripts"];
  const metadata: { generationId?: string; transcriptsEnabled?: boolean } = {};
  if (typeof generationId === "string" && generationId.length > 0) {
    metadata.generationId = generationId;
  }
  if (
    typeof transcripts === "object" &&
    transcripts !== null &&
    !Array.isArray(transcripts) &&
    (transcripts as Readonly<Record<string, unknown>>)["enabled"] === true
  ) {
    metadata.transcriptsEnabled = true;
  }
  return Object.keys(metadata).length === 0 ? undefined : Object.freeze(metadata);
}
