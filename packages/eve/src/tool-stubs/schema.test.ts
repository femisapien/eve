import { describe, expect, it } from "vitest";
import type { JsonObject, JsonValue } from "#shared/json.js";
import { parseToolStubs, StubPlayback } from "#tool-stubs/rules.js";

function matches(schema: JsonObject | boolean, value: JsonValue): boolean {
  const playback = new StubPlayback(
    parseToolStubs([{ id: "rule", tool: "lookup", match: { value: schema }, response: "matched" }]),
  );
  return playback.call({ callId: "call", tool: "lookup", input: { value } }).kind === "stub";
}

describe("tool stub JSON Schema semantics", () => {
  it("requires one contains match by default even when maxContains is specified", () => {
    expect(matches({ contains: { const: "urgent" }, maxContains: 1 }, ["normal"])).toBe(false);
  });

  it("accepts negative decimal multiples", () => {
    expect(matches({ multipleOf: 0.1 }, -0.3)).toBe(true);
  });

  it("rejects small numbers that are not a multiple", () => {
    expect(matches({ multipleOf: 1e-7 }, 1.5e-7)).toBe(false);
  });

  it("requires own JSON properties even when their names exist on Object.prototype", () => {
    expect(matches({ type: "object", required: ["constructor"] }, {})).toBe(false);
  });

  it("does not trigger a dependency on an absent own property", () => {
    expect(matches({ dependentRequired: { constructor: ["name"] } }, {})).toBe(true);
  });
});

// Expectations follow draft 2020-12. Each row owns a distinct keyword contract;
// paired examples detect both silently ignored constraints and over-rejection.
const constraints: {
  name: string;
  schema: JsonObject | boolean;
  accepted: JsonValue[];
  rejected: JsonValue[];
}[] = [
  { name: "true schema", schema: true, accepted: [null, false, 0, "", [], {}], rejected: [] },
  { name: "false schema", schema: false, accepted: [], rejected: [null, false, 0, "", [], {}] },
  { name: "empty schema", schema: {}, accepted: [null, false, 0, "", [], {}], rejected: [] },
  { name: "array type", schema: { type: "array" }, accepted: [[]], rejected: [{}] },
  { name: "boolean type", schema: { type: "boolean" }, accepted: [false], rejected: [0] },
  { name: "integer type", schema: { type: "integer" }, accepted: [-2, 0, 3], rejected: [1.5, "3"] },
  { name: "null type", schema: { type: "null" }, accepted: [null], rejected: [false] },
  {
    name: "number type without coercion",
    schema: { type: "number" },
    accepted: [1.5],
    rejected: ["1.5"],
  },
  { name: "object type", schema: { type: "object" }, accepted: [{}], rejected: [[], null] },
  { name: "string type", schema: { type: "string" }, accepted: ["3"], rejected: [3] },
  {
    name: "type union",
    schema: { type: ["integer", "null"] },
    accepted: [2, null],
    rejected: [1.5, "2"],
  },
  {
    name: "deep const equality",
    schema: { const: { a: 1, b: [2, 3] } },
    accepted: [{ b: [2, 3], a: 1 }],
    rejected: [
      { a: 1, b: [3, 2] },
      { a: 1, b: [2, 3], c: 4 },
    ],
  },
  {
    name: "enum membership",
    schema: { enum: [null, false, { id: "milk" }] },
    accepted: [null, false, { id: "milk" }],
    rejected: [0, { id: "milk", extra: true }],
  },
  { name: "minimum inclusive", schema: { minimum: 2 }, accepted: [2, 3], rejected: [1] },
  { name: "maximum inclusive", schema: { maximum: 2 }, accepted: [1, 2], rejected: [3] },
  { name: "exclusiveMinimum", schema: { exclusiveMinimum: 2 }, accepted: [3], rejected: [1, 2] },
  { name: "exclusiveMaximum", schema: { exclusiveMaximum: 2 }, accepted: [1], rejected: [2, 3] },
  {
    name: "multipleOf integers",
    schema: { multipleOf: 3 },
    accepted: [-6, 0, 9],
    rejected: [-4, 1, 4],
  },
  {
    name: "multipleOf decimals",
    schema: { multipleOf: 0.01 },
    accepted: [4.02, -4.02],
    rejected: [4.021],
  },
  {
    name: "multipleOf exponent notation",
    schema: { multipleOf: 1e-8 },
    accepted: [3e-8, -3e-8],
    rejected: [3.5e-8],
  },
  {
    name: "multipleOf large quotient",
    schema: { multipleOf: 0.5 },
    accepted: [1e308],
    rejected: [0.25],
  },
  {
    name: "minLength uses Unicode code points",
    schema: { minLength: 2 },
    accepted: ["😀a"],
    rejected: ["😀"],
  },
  {
    name: "maxLength uses Unicode code points",
    schema: { maxLength: 1 },
    accepted: ["😀"],
    rejected: ["😀a"],
  },
  {
    name: "pattern is unanchored",
    schema: { pattern: "milk" },
    accepted: ["buy milk"],
    rejected: ["walk dog"],
  },
  {
    name: "pattern honors anchors",
    schema: { pattern: "^milk$" },
    accepted: ["milk"],
    rejected: ["buy milk"],
  },
  { name: "minItems", schema: { minItems: 1 }, accepted: [[null]], rejected: [[]] },
  { name: "maxItems", schema: { maxItems: 1 }, accepted: [[], [null]], rejected: [[null, null]] },
  {
    name: "uniqueItems deep equality",
    schema: { uniqueItems: true },
    accepted: [
      [1, "1"],
      [{ a: 1 }, { a: 2 }],
    ],
    rejected: [
      [
        { a: 1, b: 2 },
        { b: 2, a: 1 },
      ],
    ],
  },
  { name: "uniqueItems false", schema: { uniqueItems: false }, accepted: [[1, 1]], rejected: [] },
  {
    name: "items checks every element",
    schema: { items: { type: "integer" } },
    accepted: [[], [1, 2]],
    rejected: [[1, "2"]],
  },
  {
    name: "prefixItems with trailing items forbidden",
    schema: { prefixItems: [{ type: "string" }, { type: "number" }], items: false },
    accepted: [[], ["a"], ["a", 1]],
    rejected: [
      [1, "a"],
      ["a", 1, true],
    ],
  },
  {
    name: "prefixItems with trailing items schema",
    schema: { prefixItems: [{ type: "string" }], items: { type: "number" } },
    accepted: [["a", 1, 2]],
    rejected: [["a", 1, "2"]],
  },
  {
    name: "contains requires a match",
    schema: { contains: { const: "urgent" } },
    accepted: [["normal", "urgent"]],
    rejected: [[], ["normal"]],
  },
  {
    name: "minContains",
    schema: { contains: { const: "urgent" }, minContains: 2 },
    accepted: [["urgent", "urgent"]],
    rejected: [["urgent", "normal"]],
  },
  {
    name: "maxContains",
    schema: { contains: { const: "urgent" }, maxContains: 1 },
    accepted: [["urgent", "normal"]],
    rejected: [["urgent", "urgent"]],
  },
  {
    name: "explicit zero contains bounds",
    schema: { contains: { const: "urgent" }, minContains: 0, maxContains: 0 },
    accepted: [[], ["normal"]],
    rejected: [["urgent"]],
  },
  {
    name: "contains bounds without contains are inert",
    schema: { minContains: 1, maxContains: 1 },
    accepted: [[], [1, 2]],
    rejected: [],
  },
  { name: "minProperties", schema: { minProperties: 1 }, accepted: [{ a: null }], rejected: [{}] },
  {
    name: "maxProperties",
    schema: { maxProperties: 1 },
    accepted: [{}, { a: null }],
    rejected: [{ a: 1, b: 2 }],
  },
  {
    name: "properties are optional and allow extra keys",
    schema: { properties: { status: { const: "open" } } },
    accepted: [{}, { status: "open", extra: true }],
    rejected: [{ status: "closed" }],
  },
  {
    name: "patternProperties and properties both apply",
    schema: {
      properties: { s_id: { minLength: 2 } },
      patternProperties: { "^s_": { type: "string" } },
    },
    accepted: [{ s_id: "ok", s_name: "Alice", other: 1 }],
    rejected: [{ s_id: "x" }, { s_name: 1 }],
  },
  {
    name: "propertyNames",
    schema: { propertyNames: { pattern: "^[a-z]+$" } },
    accepted: [{ milk: 1 }],
    rejected: [{ "milk-id": 1 }],
  },
  {
    name: "required presence includes null",
    schema: { required: ["a"] },
    accepted: [{ a: null }],
    rejected: [{}],
  },
  {
    name: "additionalProperties false",
    schema: { properties: { id: true }, additionalProperties: false },
    accepted: [{ id: 1 }],
    rejected: [{ id: 1, extra: 2 }],
  },
  {
    name: "additionalProperties schema",
    schema: {
      properties: { id: true },
      patternProperties: { "^s_": { type: "string" } },
      additionalProperties: { type: "number" },
    },
    accepted: [{ id: false, s_name: "a", count: 1 }],
    rejected: [{ count: "1" }],
  },
  {
    name: "dependentRequired",
    schema: { dependentRequired: { card: ["address"] } },
    accepted: [{}, { address: "a" }, { card: "c", address: "a" }],
    rejected: [{ card: "c" }],
  },
  {
    name: "dependentRequired property named id",
    schema: { dependentRequired: { id: ["name"] } },
    accepted: [{}, { id: 1, name: "a" }],
    rejected: [{ id: 1 }],
  },
  {
    name: "dependentSchemas validates the whole object",
    schema: {
      dependentSchemas: {
        card: { required: ["address"], properties: { address: { type: "string" } } },
      },
    },
    accepted: [{}, { address: 1 }, { card: "c", address: "a" }],
    rejected: [{ card: "c" }, { card: "c", address: 1 }],
  },
  {
    name: "own prototype-named properties",
    schema: { properties: { toString: { type: "string" } }, required: ["constructor"] },
    accepted: [{ constructor: "c", toString: "s" }],
    rejected: [{ toString: "s" }, { constructor: "c", toString: 1 }],
  },
  {
    name: "allOf",
    schema: { allOf: [{ type: "number" }, { minimum: 1 }] },
    accepted: [1],
    rejected: [0, "1"],
  },
  {
    name: "anyOf",
    schema: { anyOf: [{ type: "string" }, { minimum: 1, type: "number" }] },
    accepted: ["a", 1],
    rejected: [0, null],
  },
  {
    name: "oneOf exactly one branch",
    schema: { oneOf: [{ type: "number" }, { type: "integer" }] },
    accepted: [1.5],
    rejected: [1, "1"],
  },
  { name: "not", schema: { not: { type: "number" } }, accepted: ["1"], rejected: [1] },
  {
    name: "if then else",
    // JSON Schema keyword, not a Promise-like method.
    // oxlint-disable-next-line unicorn/no-thenable
    schema: { if: { type: "number" }, then: { minimum: 1 }, else: { const: "unknown" } },
    accepted: [1, "unknown"],
    rejected: [0, "other"],
  },
  {
    name: "then and else without if are inert",
    // oxlint-disable-next-line unicorn/no-thenable
    schema: { then: false, else: false },
    accepted: [null, 1],
    rejected: [],
  },
  {
    name: "type-specific constraints do not imply type",
    schema: { minimum: 10, minLength: 10, minItems: 10, minProperties: 10 },
    accepted: [null, false],
    rejected: [1, "x", [], {}],
  },
  {
    name: "annotations do not constrain data",
    schema: { title: "hello", description: "world", default: { pattern: "[" } },
    accepted: [null, 0, "", {}],
    rejected: [],
  },
];

it("distinguishes objects and arrays in equality and unique enum admission", () => {
  expect(matches({ const: [] }, {})).toBe(false);
  expect(matches({ const: [1] }, { "0": 1 })).toBe(false);
  expect(matches({ enum: [{}, []] }, {})).toBe(true);
  expect(matches({ enum: [{}, []] }, [])).toBe(true);
  expect(matches({ uniqueItems: true }, [[], {}])).toBe(true);
});

it("treats dependency names as instance keys, not schema identifiers", () => {
  expect(matches({ dependentRequired: { id: [] } }, {})).toBe(true);
  expect(matches({ dependentRequired: { $id: ["#"] } }, { $id: "value", "#": "present" })).toBe(
    true,
  );
  expect(matches({ dependentRequired: { $id: ["#"] } }, { $id: "value" })).toBe(false);
});

describe("supported tool stub constraints", () => {
  it.each(constraints)("$name", ({ schema, accepted, rejected }) => {
    for (const value of accepted) expect(matches(schema, value), JSON.stringify(value)).toBe(true);
    for (const value of rejected) expect(matches(schema, value), JSON.stringify(value)).toBe(false);
  });

  it("does not mutate schemas or arguments or apply defaults", () => {
    const schema = { properties: { status: { default: "open" } } };
    const value = { untouched: true };
    expect(matches(schema, value)).toBe(true);
    expect(value).toEqual({ untouched: true });
    expect(schema).toEqual({ properties: { status: { default: "open" } } });
  });
});

const invalid: JsonObject[] = [
  { unknown: true },
  { $ref: "#" },
  { format: "email" },
  { $schema: "https://json-schema.org/draft/2020-12/schema" },
  { type: "strng" },
  { type: [] },
  { type: ["string", "string"] },
  { type: ["string", "invalid"] },
  { enum: [] },
  {
    enum: [
      { a: 1, b: 2 },
      { b: 2, a: 1 },
    ],
  },
  { title: 1 },
  { description: false },
  { minimum: "1" },
  { maximum: null },
  { exclusiveMinimum: true },
  { exclusiveMaximum: false },
  { multipleOf: 0 },
  { multipleOf: -1 },
  { minLength: -1 },
  { maxLength: 0.5 },
  { pattern: 1 },
  { pattern: "[" },
  { pattern: "x".repeat(257) },
  { minItems: -1 },
  { maxItems: 0.5 },
  { uniqueItems: 1 },
  { items: [] },
  { prefixItems: [] },
  { prefixItems: [1] },
  { contains: null },
  { minContains: -1 },
  { maxContains: 0.5 },
  { minProperties: -1 },
  { maxProperties: 0.5 },
  { properties: [] },
  { properties: { x: { unknown: true } } },
  { patternProperties: { "[": true } },
  { propertyNames: 1 },
  { required: ["a", "a"] },
  { required: [1] },
  { additionalProperties: "false" },
  { dependentSchemas: { x: { $ref: "#" } } },
  { dependentRequired: { x: [1] } },
  { dependentRequired: { x: ["a", "a"] } },
  { allOf: [] },
  { anyOf: [1] },
  { oneOf: [] },
  { not: 1 },
  { if: 1 },
  // oxlint-disable-next-line unicorn/no-thenable
  { then: 1 },
  { else: 1 },
  { allOf: [{ properties: { x: { pattern: "[" } } }] },
];

it.each(invalid)("rejects malformed or unsupported constraints at setup: %j", (schema) => {
  expect(() =>
    parseToolStubs([{ id: "bad", tool: "lookup", match: { value: schema }, response: null }]),
  ).toThrow();
});
