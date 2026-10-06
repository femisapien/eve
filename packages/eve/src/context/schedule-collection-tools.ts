import { scheduleDisplayName } from "#runtime/schedules/record.js";
import { MAX_SCHEDULE_DELAY_MINUTES } from "#runtime/schedules/validation.js";
import { z } from "#compiled/zod/index.js";
import { contextStorage } from "#context/container.js";
import { AuthKey, ScheduleIdKey } from "#context/keys.js";
import { defineDynamic } from "#dynamic/definition.js";
import { markDynamicCallbackRebind } from "#internal/dynamic-tool-rebind.js";
import { scheduleCollectionToolPrefix } from "#shared/schedule-collection-tools.js";
import { parseJsonObject } from "#shared/json.js";
import { always } from "#tools/approval/policies.js";
import type { Approval } from "#public/definitions/approval.js";
import { defineTool, type ToolDefinition } from "#tools/definition.js";
import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import type { DynamicToolEntry } from "#tools/dynamic.js";
import type { ScheduleSubscriptionDefinition } from "#public/schedules/subscription.js";
import { schedules } from "#public/experimental/schedules/client.js";
import { assertScheduleManagementAllowed as assertClientScheduleManagementAllowed } from "#runtime/schedules/collection-client.js";
import {
  readDurableDynamicToolCallbacks,
  stampDurableDynamicToolCallbacks,
} from "#tools/durable-callbacks.js";

const nameSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[0-9A-Za-z][0-9A-Za-z._-]*$/u)
  .describe(
    "Readable schedule label, such as sf-weather. It may repeat; eve returns a unique management name. Start with a letter or digit; use only letters, digits, dots, underscores, and dashes. No spaces.",
  );
const timezoneSchema = z
  .string()
  .describe(
    "IANA timezone such as America/Los_Angeles or UTC. Omission means UTC. Ask only when an absolute local time or recurring wall-clock time is ambiguous; never ask for a timezone for a relative delay.",
  );
const timingGuidance =
  "For a relative request such as 'in one minute', use expression { type: 'delay', minutes: 1 }. eve computes the time; do not ask for an absolute time or timezone, guess the clock, or sleep. Delays start when this operation executes and round up to minute precision (up to 59 seconds later). For a specified wall-clock time use single/cron with its timezone; ask only if that timezone is ambiguous.";
const expressionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("cron"),
      cron: z
        .string()
        .describe(
          "Five-field cron: minute hour day-of-month month day-of-week. Use for recurring work.",
        ),
      timezone: timezoneSchema.optional(),
      jitter: z
        .number()
        .int()
        .min(1)
        .max(15)
        .optional()
        .describe("Optional maximum random delay in minutes; omit unless requested."),
    })
    .strict(),
  z
    .object({
      type: z.literal("single"),
      at: z
        .string()
        .describe(
          "Absolute local datetime YYYY-MM-DDTHH:mm, minute precision, without offset or fractions. Use delay for relative requests.",
        ),
      timezone: timezoneSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("delay"),
      minutes: z
        .number()
        .int()
        .min(1)
        .max(MAX_SCHEDULE_DELAY_MINUTES)
        .describe(
          "Whole minutes from execution, e.g. 1 for 'in one minute'. No timezone or clock lookup needed.",
        ),
    })
    .strict(),
]);

export function createScheduleCollectionToolDynamicDefinition<TPayload, TPrepared = TPayload>(
  definition: ScheduleSubscriptionDefinition<
    TPayload,
    StandardSchemaV1<unknown, TPayload>,
    TPrepared
  >,
  identity: { readonly application: string; readonly collection: string },
) {
  return markDynamicCallbackRebind(
    defineDynamic({
      events: {
        "turn.started": async (_event, context) => {
          if (
            definition.tools === false ||
            isScheduledExecution(context.session.auth.current) ||
            contextStorage.getStore()?.get(ScheduleIdKey) !== undefined
          )
            return null;

          const createSchema = z
            .object({
              name: nameSchema,
              expression: expressionSchema,
              payload: definition.schema,
            })
            .strict();
          const nameInput = z
            .object({
              name: z
                .string()
                .min(1)
                .max(256)
                .describe(
                  "Unique management name returned by create/get/list. Use the exact returned name, not its displayName or an invented suffix.",
                ),
            })
            .strict();
          const listInput = z
            .object({
              cursor: z.string().optional(),
              limit: z.number().int().min(1).max(100).optional(),
            })
            .strict();
          const describe = (text: string) =>
            `${definition.description === undefined ? "" : `${definition.description}\n\n`}${text}`;
          const approval = definition.tools?.approval;
          const policy = (operation: keyof NonNullable<typeof approval>, defaultApproval = false) =>
            approval?.[operation] ?? (defaultApproval ? always() : undefined);
          const define = (
            action: string,
            description: string,
            inputSchema: any,
            run: (input: any) => Promise<unknown>,
            approval?: Approval,
          ): DynamicToolEntry => {
            const entry: ToolDefinition<any, unknown> = {
              description: describe(description),
              label: {
                start: (input: { name?: string }) =>
                  input.name ? `${action}: ${scheduleDisplayName(input.name)}` : action,
              },
              inputSchema,
              execute: async (input: any) => {
                assertScheduleManagementAllowed();
                return await run(input);
              },
            };
            if (approval !== undefined) entry.approval = approval;
            return defineTool(entry) as DynamicToolEntry;
          };
          const prefix = `${scheduleCollectionToolPrefix(identity.collection)}__`;
          const operations: Record<string, DynamicToolEntry> = {
            [`${prefix}create`]: define(
              "Create schedule",
              `Create a future schedule occurrence, not an immediate action. The supplied name is a display label and may repeat; the receipt returns a unique name for management. Never get/list merely to find an unused display name. ${timingGuidance} Supply the payload required by this subscription. The callback resolves destinations and starts work as the creator. The original conversation is not implicitly captured. Stored payload is not available from get/list and cannot be edited later.`,
              createSchema,
              async (input) => await (await schedules(definition as never)).create(input),
              policy("create", true),
            ),
            [`${prefix}get`]: define(
              "Read schedule",
              "Read schedule timing and state. Stored payload and creator data are not returned.",
              nameInput,
              async ({ name }) => await (await schedules(definition as never)).get(name),
              policy("get"),
            ),
            [`${prefix}list`]: define(
              "List schedules",
              "List schedule names, timing, and state. Stored payload and creator data are not returned.",
              listInput,
              async (input) => await (await schedules(definition as never)).list(input),
              policy("list"),
            ),
            [`${prefix}enable`]: define(
              "Enable schedule",
              "Enable future schedule occurrences.",
              nameInput,
              async ({ name }) => await (await schedules(definition as never)).enable(name),
              policy("enable", true),
            ),
            [`${prefix}disable`]: define(
              "Disable schedule",
              "Disable future schedule occurrences; already started work is not cancelled.",
              nameInput,
              async ({ name }) => await (await schedules(definition as never)).disable(name),
              policy("disable", true),
            ),
            [`${prefix}invoke`]: define(
              "Run schedule",
              "Enqueue an additional occurrence. Acceptance does not mean execution succeeded.",
              nameInput,
              async ({ name }) => {
                await (await schedules(definition as never)).invoke(name);
                return { accepted: true };
              },
              policy("invoke", true),
            ),
            [`${prefix}delete`]: define(
              "Delete schedule",
              "Delete a schedule; already started work is not cancelled.",
              nameInput,
              async ({ name }) => ({
                deleted: await (await schedules(definition as never)).delete(name),
              }),
              policy("delete", true),
            ),
          };
          for (const tool of Object.values(operations)) stampGeneratedToolCallbacks(tool);
          return operations;
        },
      },
    }),
  );
}

function isScheduledExecution(
  auth: { readonly attributes: Readonly<Record<string, string | readonly string[]>> } | null,
): boolean {
  const value = auth?.attributes["eve.scheduled_run"];
  return value === "true" || (Array.isArray(value) && value.includes("true"));
}

function assertScheduleManagementAllowed(): void {
  assertClientScheduleManagementAllowed(contextStorage.getStore()?.get(AuthKey) ?? null);
}

function stampGeneratedToolCallbacks(tool: unknown): void {
  const entry = tool as DynamicToolEntry;
  const closure = parseJsonObject({});
  const callbacks: Parameters<typeof stampDurableDynamicToolCallbacks>[1] = {
    ...readDurableDynamicToolCallbacks(entry),
    execute: {
      callback: async (_rawClosure, toolInput, context) => await entry.execute(toolInput, context),
      closure,
    },
    inputSchema: { callback: async () => entry.inputSchema, closure },
    label: {
      start: {
        callback: async (_closure, input) => entry.label!.start(input as Record<string, unknown>),
        closure,
      },
    },
  };
  stampDurableDynamicToolCallbacks(entry, callbacks);
}
