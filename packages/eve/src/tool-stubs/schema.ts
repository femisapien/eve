import { Validator } from "#compiled/@cfworker/json-schema/index.js";
import type { JsonObject } from "#shared/json.js";
import { isObject } from "#shared/guards.js";

const schema = { $ref: "#" };
const schemaList = { type: "array", minItems: 1, items: schema };
const schemaMap = { type: "object", additionalProperties: schema };
const strings = { type: "array", uniqueItems: true, items: { type: "string" } };
const nonnegativeInteger = { type: "integer", minimum: 0 };
const jsonType = { enum: ["array", "boolean", "integer", "null", "number", "object", "string"] };

// A deliberately bounded, reference-free subset. The validator accepts unknown
// keywords and malformed schemas, which would silently broaden a stub's match.
const constraintSchema = new Validator(
  {
    anyOf: [
      { type: "boolean" },
      {
        type: "object",
        additionalProperties: false,
        properties: {
          type: {
            anyOf: [jsonType, { type: "array", minItems: 1, uniqueItems: true, items: jsonType }],
          },
          const: true,
          enum: { type: "array", minItems: 1, uniqueItems: true },
          title: { type: "string" },
          description: { type: "string" },
          default: true,
          minimum: { type: "number" },
          maximum: { type: "number" },
          exclusiveMinimum: { type: "number" },
          exclusiveMaximum: { type: "number" },
          multipleOf: { type: "number", exclusiveMinimum: 0 },
          minLength: nonnegativeInteger,
          maxLength: nonnegativeInteger,
          pattern: { type: "string", maxLength: 256 },
          minItems: nonnegativeInteger,
          maxItems: nonnegativeInteger,
          uniqueItems: { type: "boolean" },
          items: schema,
          prefixItems: schemaList,
          contains: schema,
          minContains: nonnegativeInteger,
          maxContains: nonnegativeInteger,
          minProperties: nonnegativeInteger,
          maxProperties: nonnegativeInteger,
          properties: schemaMap,
          patternProperties: schemaMap,
          propertyNames: schema,
          required: strings,
          additionalProperties: schema,
          dependentSchemas: schemaMap,
          dependentRequired: { type: "object", additionalProperties: strings },
          allOf: schemaList,
          anyOf: schemaList,
          oneOf: schemaList,
          not: schema,
          if: schema,
          // JSON Schema keyword, not a Promise-like method.
          // oxlint-disable-next-line unicorn/no-thenable
          then: schema,
          else: schema,
        },
      },
    ],
  },
  "2020-12",
);

export function validateStubConstraint(value: unknown): void {
  if (!constraintSchema.validate(value).valid) {
    throw new Error(
      "Invalid tool stub JSON Schema. Use supported, reference-free JSON Schema constraints.",
    );
  }
  validatePatterns(value);
}

export function compileStubConstraint(value: JsonObject | boolean): Validator {
  return new Validator(structuredClone(value), "2020-12");
}

function validatePatterns(value: unknown): void {
  if (!isObject(value)) return;
  if (typeof value.pattern === "string") new RegExp(value.pattern, "u");
  if (isObject(value.patternProperties)) {
    for (const pattern of Object.keys(value.patternProperties)) new RegExp(pattern, "u");
  }
  for (const key of [
    "items",
    "contains",
    "additionalProperties",
    "propertyNames",
    "not",
    "if",
    "then",
    "else",
  ]) {
    validatePatterns(value[key]);
  }
  for (const key of ["prefixItems", "allOf", "anyOf", "oneOf"]) {
    if (Array.isArray(value[key])) for (const child of value[key]) validatePatterns(child);
  }
  for (const key of ["properties", "patternProperties", "dependentSchemas"]) {
    if (isObject(value[key]))
      for (const child of Object.values(value[key])) validatePatterns(child);
  }
}
