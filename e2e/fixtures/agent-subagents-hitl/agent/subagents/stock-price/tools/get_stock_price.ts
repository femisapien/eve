import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Get the current stock price for a ticker symbol.",
  inputSchema: z.object({
    ticker: z.string().describe("Stock ticker symbol"),
  }),
  approval: once(),
  async execute() {
    throw new Error("get_stock_price requires an eval tool stub.");
  },
});
