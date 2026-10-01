import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import type { MockModelRequest, MockModelResponse } from "eve/evals";

const REPLY_DIRECTIVE = /reply with exactly ([A-Z0-9-]+)/iu;
const READ_STATUS_DIRECTIVE = /call the (read-status) tool exactly once with marker "([^"]+)"/iu;
const ASK_QUESTION_DIRECTIVE = /call the ask_question tool exactly once with question "([^"]+)"/iu;

/**
 * Scripted mock for the world suites: untagged evals in this fixture phrase
 * every prompt as an explicit directive, so the responder executes exactly
 * the requested tool call and replies from its output. A tool message after
 * the latest user message means this turn's call already ran.
 */
function respond(request: MockModelRequest): MockModelResponse | string {
  const message = request.lastUserMessage ?? "";

  const readStatus = READ_STATUS_DIRECTIVE.exec(message);
  if (readStatus?.[1] !== undefined && readStatus[2] !== undefined) {
    const roles = request.messages.map((entry) => entry.role);
    if (roles.lastIndexOf("tool") < roles.lastIndexOf("user")) {
      return {
        toolCalls: [{ name: readStatus[1], input: { marker: readStatus[2] } }],
      };
    }
    const output = [...request.toolResults]
      .reverse()
      .find((result) => result.name === readStatus[1])?.output;
    return JSON.stringify(output ?? "Missing tool result");
  }

  const reply = REPLY_DIRECTIVE.exec(message);
  if (reply?.[1] !== undefined) {
    return reply[1];
  }

  const askQuestion = ASK_QUESTION_DIRECTIVE.exec(message);
  if (askQuestion?.[1] !== undefined) {
    const roles = request.messages.map((entry) => entry.role);
    if (roles.lastIndexOf("tool") < roles.lastIndexOf("user")) {
      return {
        toolCalls: [
          {
            input: {
              options: [
                { description: "Ship to the staging environment first.", label: "Staging" },
                { description: "Ship straight to production.", label: "Production" },
              ],
              question: askQuestion[1],
            },
            name: "ask_question",
          },
        ],
      };
    }
    const output = [...request.toolResults]
      .reverse()
      .find((result) => result.name === "ask_question")?.output;
    return `ask_question result: ${JSON.stringify(output ?? "")}`;
  }

  return `Mock reply: ${message}`;
}

export default defineAgent({
  ...e2eAgentConfig({ mock: respond }),
  reasoning: "high",
});
