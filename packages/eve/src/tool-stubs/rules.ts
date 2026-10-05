import { isObject } from "#shared/guards.js";
import { parseJsonValue } from "#shared/json.js";
import { compileStubConstraint, validateStubConstraint } from "#tool-stubs/schema.js";
import type { StubCall, StubResult, ToolStub } from "#tool-stubs/types.js";

/** Validates the wire contract before admitting a stubbed session. */
export function parseToolStubs(value: unknown): readonly ToolStub[] {
  boundStubConfiguration(value);
  const rules = parseJsonValue(value);
  if (!Array.isArray(rules) || rules.length > 100)
    throw new Error("Expected at most 100 tool stubs.");
  const ids = new Set<string>();
  for (const rule of rules) {
    if (
      !isObject(rule) ||
      typeof rule.id !== "string" ||
      !rule.id ||
      typeof rule.tool !== "string" ||
      !rule.tool ||
      ids.has(rule.id)
    ) {
      throw new Error("Each tool stub needs a unique id and a tool name.");
    }
    ids.add(rule.id);
    if (rule.tool === "connection_execute" || rule.tool === "connection_search") {
      throw new Error(
        "Stub connection operations by their qualified connection__tool name; connection discovery and validation remain live.",
      );
    }
    if (
      Object.keys(rule).some(
        (key) => !["id", "tool", "match", "response", "responses"].includes(key),
      )
    ) {
      throw new Error(`Unknown field in tool stub "${rule.id}".`);
    }
    if (
      Object.hasOwn(rule, "response") === Object.hasOwn(rule, "responses") ||
      (Object.hasOwn(rule, "responses") &&
        (!Array.isArray(rule.responses) || rule.responses.length === 0))
    ) {
      throw new Error(
        `Tool stub "${rule.id}" needs exactly one response or a nonempty responses array.`,
      );
    }
    if (rule.match !== undefined && !isObject(rule.match))
      throw new Error("Tool stub match must be a property-to-schema object.");
    for (const schema of Object.values(rule.match ?? {})) validateStubConstraint(schema);
  }
  return rules as readonly ToolStub[];
}

/** Deterministic playback; its owner supplies durable, serial call admission. */
export class StubPlayback {
  private readonly rules;
  private readonly results = new Map<string, StubResult>();
  private readonly positions = new Map<string, number>();

  constructor(rules: readonly ToolStub[]) {
    this.rules = rules.map((rule) => ({
      ...rule,
      constraints: Object.entries(rule.match ?? {}).map(([property, schema]) => ({
        property,
        validator: compileStubConstraint(schema),
      })),
    }));
  }

  call(call: StubCall): StubResult {
    const recorded = this.results.get(call.callId);
    if (recorded !== undefined) return recorded;
    if (this.results.size >= 10_000)
      return {
        kind: "error",
        error: "Tool stub session exceeded 10,000 calls. Start a new eval session.",
      };
    const candidates = this.rules.filter((rule) => rule.tool === call.tool);
    if (call.persistent && candidates.some((rule) => rule.constraints.length > 0)) {
      return this.record(call, {
        kind: "error",
        error: `Persistent tool "${call.tool}" requires an unconditional stub.`,
      });
    }
    const matching = candidates.filter((rule) =>
      rule.constraints.every(
        ({ property, validator }) =>
          isObject(call.input) &&
          Object.hasOwn(call.input, property) &&
          validator.validate(call.input[property]).valid,
      ),
    );
    if (matching.length > 1) {
      return this.record(call, {
        kind: "error",
        error: `Ambiguous tool stubs for "${call.tool}": ${matching.map((rule) => rule.id).join(", ")}.`,
      });
    }
    const rule = matching[0];
    if (rule === undefined) return this.record(call, { kind: "real" });
    const responses = rule.responses ?? [rule.response!];
    const position = Math.min(this.positions.get(rule.id) ?? 0, responses.length - 1);
    this.positions.set(rule.id, position + 1);
    return this.record(call, {
      kind: "stub",
      ruleId: rule.id,
      position,
      response: responses[position]!,
    });
  }

  private record(call: StubCall, result: StubResult): StubResult {
    this.results.set(call.callId, result);
    return result;
  }

  fail(callId: string, error: string): StubResult {
    return this.results.get(callId)?.kind === "stub" ? { kind: "error", error } : { kind: "real" };
  }
}

function boundStubConfiguration(value: unknown): void {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  let size = 0;
  while (pending.length > 0) {
    const entry = pending.pop()!;
    if (++nodes > 20_000 || entry.depth > 32) {
      throw new Error("Tool stubs exceed the size or nesting limit.");
    }
    if (typeof entry.value === "string") size += entry.value.length;
    if (entry.value !== null && typeof entry.value === "object") {
      for (const [key, child] of Object.entries(entry.value)) {
        if (key === "__proto__") throw new Error("Tool stubs cannot contain prototype keys.");
        size += key.length;
        pending.push({ value: child, depth: entry.depth + 1 });
      }
    }
    if (size > 1_000_000) throw new Error("Tool stubs exceed the size or nesting limit.");
  }
}
