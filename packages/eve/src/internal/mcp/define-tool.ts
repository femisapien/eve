import type {
  McpJsonObject,
  StandardSchemaWithJSON,
} from "#compiled/@modelcontextprotocol/server/index.js";

import type { SessionAuthContext } from "#channel/types.js";
import {
  callTool,
  type McpCallToolResult,
  type McpServerTool,
  type McpToolDefinition,
} from "#internal/mcp/streamable-http-server.js";

type InferSchemaOutput<TSchema> =
  TSchema extends StandardSchemaWithJSON<unknown, infer TOutput> ? TOutput : never;

/** Keeps a schema and its inferred handler input coupled while erasing heterogeneous storage. */
export function defineMcpTool<
  const TInputSchema extends StandardSchemaWithJSON<unknown, unknown>,
  TStructured extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
  TAuth = SessionAuthContext | null,
>(input: {
  readonly definition: McpToolDefinition<TInputSchema>;
  call(
    value: InferSchemaOutput<TInputSchema>,
    context: { readonly auth: TAuth; readonly signal: AbortSignal },
  ): Promise<McpCallToolResult<TStructured>>;
}): McpServerTool<TAuth> {
  return {
    name: input.definition.name,
    register(server, auth) {
      server.registerTool(
        input.definition.name,
        {
          ...(input.definition.annotations === undefined
            ? {}
            : { annotations: input.definition.annotations }),
          ...(input.definition.description === undefined
            ? {}
            : { description: input.definition.description }),
          inputSchema: input.definition.inputSchema,
          ...(input.definition.outputSchema === undefined
            ? {}
            : { outputSchema: input.definition.outputSchema }),
        },
        async (value, context) =>
          await callTool(
            input.call,
            value as InferSchemaOutput<TInputSchema>,
            context.mcpReq.signal,
            auth,
          ),
      );
    },
    raw: {
      listed() {
        const { annotations, description, inputSchema, name, outputSchema } = input.definition;
        const listed: Record<string, unknown> = {
          inputSchema: toolJsonSchema(inputSchema, "input"),
          name,
        };
        if (annotations !== undefined) listed.annotations = annotations;
        if (description !== undefined) listed.description = description;
        if (outputSchema !== undefined)
          listed.outputSchema = toolJsonSchema(outputSchema, "output");
        return listed;
      },
      async call(args, context) {
        const validated = await standardSchema(input.definition.inputSchema).validate(args ?? {});
        if (validated.issues !== undefined && validated.issues.length > 0) {
          const issues = validated.issues.map(formatSchemaIssue).join(", ");
          return {
            content: [
              {
                text: `Input validation error: Invalid arguments for tool ${input.definition.name}: ${issues}`,
                type: "text",
              },
            ],
            isError: true,
          };
        }
        return await callTool(
          input.call,
          validated.value as InferSchemaOutput<TInputSchema>,
          context.signal,
          context.auth,
        );
      },
    },
  };
}

// The rest of this file mirrors what `McpServer.registerTool` does with a
// Standard Schema (draft 2020-12 JSON Schema, object roots, issue text), so a
// tool reads the same whether the SDK or a feature serves it.

interface StandardSchemaRuntime {
  readonly jsonSchema?: Readonly<
    Record<"input" | "output", (options: { readonly target: string }) => Record<string, unknown>>
  >;
  validate(value: unknown): Promise<{
    readonly issues?: readonly {
      readonly message: string;
      readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[];
    }[];
    readonly value?: unknown;
  }>;
}

function standardSchema(schema: StandardSchemaWithJSON): StandardSchemaRuntime {
  return schema["~standard"] as StandardSchemaRuntime;
}

function toolJsonSchema(schema: StandardSchemaWithJSON, io: "input" | "output"): McpJsonObject {
  const convert = standardSchema(schema).jsonSchema?.[io];
  if (convert === undefined) {
    throw new Error(
      "MCP tool schemas must implement Standard JSON Schema (`~standard.jsonSchema`).",
    );
  }
  const json = convert({ target: "draft-2020-12" });
  if (io === "output") {
    return json.type === undefined && describesObject(json) ? { type: "object", ...json } : json;
  }
  if (json.type !== undefined && json.type !== "object") {
    throw new Error(
      `MCP tool input schemas must describe objects (got type: ${JSON.stringify(json.type)}).`,
    );
  }
  return { type: "object", ...json };
}

function describesObject(json: Readonly<Record<string, unknown>>): boolean {
  if (
    ["properties", "patternProperties", "additionalProperties", "required"].some(
      (key) => key in json,
    )
  ) {
    return true;
  }
  for (const key of ["oneOf", "anyOf", "allOf"]) {
    const branches = json[key];
    if (Array.isArray(branches) && branches.length > 0) {
      return branches.every(
        (branch) =>
          typeof branch === "object" &&
          branch !== null &&
          (branch.type === "object" || describesObject(branch as Record<string, unknown>)),
      );
    }
  }
  return false;
}

function formatSchemaIssue(issue: {
  readonly message: string;
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[];
}): string {
  if (issue.path === undefined || issue.path.length === 0) return issue.message;
  const path = issue.path
    .map((segment) => String(typeof segment === "object" ? segment.key : segment))
    .join(".");
  return `${path}: ${issue.message}`;
}
