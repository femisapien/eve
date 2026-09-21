import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  WEB_APP_TEMPLATE_FILES,
  WEB_APP_SIGN_IN_WITH_VERCEL_TEMPLATE_FILES,
  WEB_APP_TEMPLATE_PACKAGE_JSON,
} from "../packages/eve/src/setup/scaffold/create/web-template.ts";

const root = resolve(import.meta.dirname, "..");
const authenticated = process.argv.includes("--authenticated");
const target = join(root, authenticated ? ".web-preview-auth" : ".web-preview");
const files = {
  ...WEB_APP_TEMPLATE_FILES,
  ...(authenticated ? WEB_APP_SIGN_IN_WITH_VERCEL_TEMPLATE_FILES : {}),
};
for (const [name, source] of Object.entries(files)) {
  const path = join(target, name);
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(
    path,
    source
      .replaceAll("__EVE_INIT_APP_NAME__", "Web chat preview")
      .replaceAll("__EVE_INIT_WITH_EVE_OPTIONS__", ""),
  );
}
await writeFile(
  join(target, "package.json"),
  JSON.stringify(
    {
      name: "eve-web-preview",
      private: true,
      type: "module",
      ...WEB_APP_TEMPLATE_PACKAGE_JSON,
      dependencies: {
        ...WEB_APP_TEMPLATE_PACKAGE_JSON.dependencies,
        eve: "link:../packages/eve",
        ai: "^7.0.105",
        ...(authenticated ? { "better-auth": "1.6.26" } : {}),
      },
    },
    null,
    2,
  ),
);
await writeFile(
  join(target, "pnpm-workspace.yaml"),
  "packages: []\nallowBuilds:\n  esbuild: true\n  sharp: false\n",
);
const reply =
  "Received. [Documentation](https://eve.dev) and inline `code`.\n\n```text\nsandbox-ok\nReady for the next message.\n```";
const agent = [
  "import { defineAgent } from 'eve';",
  "import { mockModel } from 'eve/evals';",
  "export default defineAgent({",
  "  modelContextWindowTokens: 1000000,",
  "  model: mockModel(({ lastUserMessage, toolResults }) => lastUserMessage?.includes('delegate') && !toolResults.some((result) => result.name === 'researcher')",
  "    ? { toolCalls: [{ name: 'researcher', input: { message: 'Inspect the integration fixture.' } }] }",
  "    : lastUserMessage?.includes('long')",
  "    ? Array.from({length: 30}, (_, i) => (i + 1) + '. Scroll verification').join('\\n')",
  "    : " + JSON.stringify(reply) + "),",
  "});",
].join("\n");
await writeFile(join(target, "agent/agent.ts"), agent);
await writeFile(join(target, "agent/instructions.md"), "Deterministic web integration fixture.");
console.log(target);

await writeFile(join(target, ".npmrc"), "registry=https://registry.npmjs.org/\n");

await mkdir(join(target, "agent/subagents/researcher"), { recursive: true });
await writeFile(
  join(target, "agent/subagents/researcher/agent.ts"),
  [
    "import { defineAgent } from 'eve';",
    "import { mockModel } from 'eve/evals';",
    "export default defineAgent({ description: 'Inspect the UI fixture.', modelContextWindowTokens: 1000000, model: mockModel('The child completed its inspection. All fixture data is deterministic.') });",
  ].join("\n"),
);
