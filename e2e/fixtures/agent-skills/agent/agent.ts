import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent, defineDynamic } from "eve";
import { DYNAMIC_PACKAGE_REQUESTS, dynamicSkillPackageModel } from "./lib/dynamic-skill-package";
import { PREFIX_REQUEST, prefixModel } from "./lib/prompt-prefix";
import type { MockModelRequest } from "eve/evals";

const DYNAMIC_INSTRUCTIONS_TOKEN = "dynamic-instructions-ok-M3K8";

function respond(request: MockModelRequest): string {
  const hasDynamicUserInstruction = request.userMessages.some((message) =>
    message.includes(DYNAMIC_INSTRUCTIONS_TOKEN),
  );
  return hasDynamicUserInstruction ? DYNAMIC_INSTRUCTIONS_TOKEN : "missing dynamic instructions";
}

const { model, modelContextWindowTokens, ...config } = e2eAgentConfig({ mock: respond });

export default defineAgent({
  ...config,
  model: defineDynamic({
    events: {
      "step.started": (_event, ctx) => {
        if (
          ctx.messages.some(
            (message) =>
              message.role === "user" &&
              typeof message.content === "string" &&
              Object.values(DYNAMIC_PACKAGE_REQUESTS).includes(message.content),
          )
        ) {
          return { model: dynamicSkillPackageModel, modelContextWindowTokens: 1_000_000 };
        }
        return ctx.messages.some(
          (message) => message.role === "user" && message.content === PREFIX_REQUEST,
        )
          ? { model: prefixModel, modelContextWindowTokens: 1_000_000 }
          : { model, modelContextWindowTokens };
      },
    },
  }),
  reasoning: "high",
});
