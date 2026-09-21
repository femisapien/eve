import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
export default defineAgent({
  modelContextWindowTokens: 1000000,
  model: mockModel(({ lastUserMessage, toolResults }) =>
    lastUserMessage?.includes("delegate") &&
    !toolResults.some((result) => result.name === "researcher")
      ? {
          toolCalls: [
            { name: "researcher", input: { message: "Inspect the integration fixture." } },
          ],
        }
      : lastUserMessage?.includes("details") &&
          !toolResults.some((result) => result.name === "inspect_fixture")
        ? {
            toolCalls: [
              {
                name: "inspect_fixture",
                input: { command: "inspect --session fixture", format: "json" },
              },
            ],
          }
        : lastUserMessage?.includes("long")
          ? Array.from({ length: 30 }, (_, i) => i + 1 + ". Scroll verification").join("\n")
          : 'Here is the result. [Documentation](https://eve.dev) and inline `code` stay readable.\n\n```sql\nSELECT project_id, count(*) AS runs\nFROM sessions\nWHERE status = \'complete\'\nGROUP BY project_id;\n```\n\n```json\n{ "status": "ready", "count": 4 }\n```\n\n```text\nsandbox-ok\nReady for the next message.\n```',
  ),
});
