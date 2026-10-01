import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

function respond(request: MockModelRequest): MockModelResponse | string {
  const message = request.lastUserMessage ?? "";
  if (message.includes("Call the approval-child subagent exactly once")) {
    const approval = taskResultOf(request, "approval-child");
    if (approval !== undefined) return approval;
    if (hasReceipt(request, "approval-child")) return waitForTasks();
    return {
      toolCalls: [
        {
          input: { message: "Ask whether to deploy, then wait for the answer." },
          name: "approval-child",
        },
      ],
    };
  }
  if (message.includes("Call the stock-price subagent exactly once")) {
    const quote = taskResultOf(request, "stock-price");
    if (quote !== undefined) return `The stock-price subagent returned: ${quote}`;
    if (hasReceipt(request, "stock-price")) return waitForTasks();
    return {
      toolCalls: [
        {
          input: {
            message:
              'Call the get_stock_price tool exactly once with ticker "GOOG". After it returns, do not call any tool again; return the result.',
          },
          name: "stock-price",
        },
      ],
    };
  }
  return `Mock reply: ${message}`;
}

/** An agent call returns a receipt; its result arrives later in a `<task_result>` message. */
function taskResultOf(request: MockModelRequest, tool: string): string | undefined {
  const pattern = new RegExp(`<task_result [^>]*tool="${tool}"[^>]*>([\\s\\S]*?)</task_result>`);
  for (const message of [...request.messages].reverse()) {
    if (message.role !== "user") continue;
    const body = message.text.match(pattern)?.[1];
    if (body !== undefined) return body;
  }
  return undefined;
}

function hasReceipt(request: MockModelRequest, tool: string): boolean {
  return request.toolResults.some((result) => result.name === tool);
}

function waitForTasks(): MockModelResponse {
  return { toolCalls: [{ input: {}, name: "task_wait" }] };
}

export default defineAgent({
  ...e2eAgentConfig(),
  // The parent is scripted so the relayed question is deterministic; children use the matrix model.
  model: mockModel(respond),
  modelContextWindowTokens: 1_000_000,
});
