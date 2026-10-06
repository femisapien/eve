import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  description:
    'Look up the current stock price for a given ticker symbol. Pass the ticker symbol you want to look up in the message (e.g. "AAPL", "GOOG", or "TSLA").',
  ...e2eSubagentConfig({
    mock: ({ toolResults }) => {
      const quote = toolResults.find((result) => result.name === "get_stock_price");
      return quote === undefined
        ? { toolCalls: [{ input: { ticker: "GOOG" }, name: "get_stock_price" }] }
        : JSON.stringify(quote.output);
    },
  }),
  reasoning: "high",
});
