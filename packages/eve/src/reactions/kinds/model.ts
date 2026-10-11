import { runOnSelection, type ContextContainer } from "#context/container.js";
import type { ContextReader } from "#context/key.js";
import { StaticModelReferenceKey, type LiveDynamicModelSelection } from "#context/keys.js";
import { isMockModel } from "#internal/mock-model-identity.js";
import {
  loadDynamicRuntimeModelDefinition,
  resolveRuntimeModelSelection,
  shouldMockAuthoredRuntimeModels,
} from "#runtime/agent/resolve-model.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { PublicAgentDynamicModelResult } from "#shared/agent-definition.js";
import { toErrorMessage } from "#shared/errors.js";
import type { JsonValue } from "#shared/json.js";
import type { ResolveContext } from "#dynamic/definition.js";
import { readsConversation } from "#dynamic/model-options.js";
import {
  authoredBuild,
  publicResolveContext,
  type InternalResolveContext,
  type Reaction,
} from "../reaction.js";
import { readLive, readReactionsState } from "../state.js";

const MODEL_REACTION_ID = "model:agent";
const DYNAMIC_MODEL_SELECTION_ERROR_CODE = "EVE_DYNAMIC_MODEL_SELECTION_FAILED";

/** A dynamic `model` failed to choose a model: the model call that needs it fails. */
export class DynamicModelSelectionError extends Error {
  readonly code = DYNAMIC_MODEL_SELECTION_ERROR_CODE;
  override readonly name = "DynamicModelSelectionError";

  constructor(error: unknown) {
    super(toErrorMessage(error), { cause: error });
  }
}

export function isDynamicModelSelectionError(error: unknown): error is DynamicModelSelectionError {
  return (
    error instanceof DynamicModelSelectionError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { readonly code?: unknown }).code === DYNAMIC_MODEL_SELECTION_ERROR_CODE)
  );
}

/** What the model slot records: the model chosen. */
interface ModelSlotValue {
  readonly reference: LiveDynamicModelSelection["reference"];
}

/**
 * An agent's dynamic `model` field. `resolve` returns the model, or the JSON it's made from; a
 * gateway ID is data, and a provider object is code, which `build` creates. auto() records the
 * option it chose, and builds the model from it.
 */
export async function loadModelReaction(bundle: CompiledBundle): Promise<Reaction | undefined> {
  const dynamicModel = bundle.turnAgent.dynamicModel;
  if (dynamicModel === undefined) return undefined;
  const definition = await loadDynamicRuntimeModelDefinition({
    dynamicModel,
    scope: { moduleMap: bundle.moduleMap, nodeId: bundle.nodeId },
  });
  const label = `${dynamicModel.logicalPath}#model`;
  // auto() reads the conversation before the turn when it decides, so it runs where a step has it.
  const conversation = readsConversation(definition);
  const resolve = definition.resolve as
    | ((selected: unknown, ctx: ResolveContext) => unknown)
    | undefined;
  return {
    // Without an authored build, the model is the JSON resolve returned, such as a gateway ID.
    build:
      authoredBuild(label, definition.build as never, { framework: conversation }) ??
      ((input) => input),
    contribute: async (result, { ctx }) => {
      // auto() resolves to nothing before there's a turn to choose for.
      if (result === null && conversation) return { value: null };
      try {
        return await contributionOf(result, ctx);
      } catch (error) {
        throw new DynamicModelSelectionError(error);
      }
    },
    // A failed selection fails the model call that needs it, not the commit that ran it: a commit
    // before the turn's input, say, may have nothing to choose from yet.
    ...(conversation ? { conversation: true } : {}),
    id: MODEL_REACTION_ID,
    kind: "model",
    label,
    ...(resolve === undefined
      ? {}
      : {
          resolve: async (selected: unknown, ctx: InternalResolveContext) => {
            try {
              const context = conversation
                ? { ...publicResolveContext(ctx), messages: ctx.messages ?? [] }
                : publicResolveContext(ctx);
              return await runOnSelection(dynamicModel.logicalPath, () =>
                resolve(selected, context),
              );
            } catch (error) {
              throw new DynamicModelSelectionError(error);
            }
          },
        }),
    select: definition.select as NonNullable<Reaction["select"]>,
  };
}

/** Resolves a model result to what the slot records, and the provider the process holds. */
async function contributionOf(
  result: unknown,
  ctx: ContextContainer,
): Promise<{ readonly value: JsonValue; readonly live?: LiveDynamicModelSelection }> {
  const selection = await resolveRuntimeModelSelection({
    durability: "live",
    selection: result as PublicAgentDynamicModelResult,
    state: ctx,
  });
  // Mock runs replace real providers, but keep explicitly scripted responders.
  const live =
    selection.model === undefined ||
    (!isMockModel(selection.model) && shouldMockAuthoredRuntimeModels())
      ? undefined
      : selection;
  const value: ModelSlotValue = { reference: selection.reference };
  return { live, value: value as unknown as JsonValue };
}

/** The model the next call uses: the dynamic agent's, or the static one. Throws a failed selection. */
export function getEffectiveModelSelection(
  ctx: Pick<ContextReader, "get">,
): LiveDynamicModelSelection | null {
  const slot = readReactionsState(ctx).slots[MODEL_REACTION_ID];
  if (slot?.error !== undefined) throw new DynamicModelSelectionError(new Error(slot.error));
  if (slot !== undefined && slot.value !== null) {
    const live = readLive(ctx, MODEL_REACTION_ID, slot);
    return (
      (live?.live as LiveDynamicModelSelection | undefined) ?? {
        reference: (slot.value as unknown as ModelSlotValue).reference,
      }
    );
  }
  const staticModel = ctx.get(StaticModelReferenceKey);
  return staticModel === null || staticModel === undefined ? null : { reference: staticModel };
}

export function effectiveModelId(ctx: ContextContainer): string | undefined {
  try {
    return getEffectiveModelSelection(ctx)?.reference.id;
  } catch {
    return undefined;
  }
}
