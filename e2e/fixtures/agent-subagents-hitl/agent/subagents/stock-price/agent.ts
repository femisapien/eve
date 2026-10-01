import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

/** The gated lookup answers with a receipt; the price arrives as the task's result. */
function taskResult(messages: readonly { readonly role: string; readonly text: string }[]) {
  return [...messages]
    .reverse()
    .find((message) => message.role === "user" && message.text.includes('tool="get_stock_price"'));
}

export default defineAgent({
  description:
    'Look up the current stock price for a given ticker symbol. Pass the ticker symbol you want to look up in the message (e.g. "AAPL", "GOOG", or "TSLA").',
  ...e2eSubagentConfig({
    mock: ({ messages, toolResults }) => {
      const result = taskResult(messages);
      if (result !== undefined) return `Lookup result: ${result.text}`;
      if (toolResults.some((result) => result.name === "get_stock_price")) {
        return { toolCalls: [{ input: {}, name: "task_wait" }] };
      }
      return { toolCalls: [{ input: { ticker: "GOOG" }, name: "get_stock_price" }] };
    },
  }),
  reasoning: "high",
});
