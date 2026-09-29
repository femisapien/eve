import { spawn, type ChildProcess } from "node:child_process";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EVE_INTERNAL_AGENT_SELECTION_ENV } from "../../src/internal/application/agent-selection-environment.js";
import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import { DEV_SERVER_SCENARIO_TIMEOUT_MS } from "./dev-server-descriptors.js";
import { fetchAgentInfo, startEveDev, waitForCondition } from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();
const SELECTION_ENV = {
  [EVE_INTERNAL_AGENT_SELECTION_ENV]: JSON.stringify({
    entry: "src/support.ts",
    registration: "support",
  }),
};
const ADJACENT_FAILURE = "Adjacent filesystem source must not load";

const ENTRY_HOST_DESCRIPTOR: ScenarioAppDescriptor = {
  name: "entry-host",
  installDependencies: true,
  dependencies: { zod: "4.5.4" },
  files: {
    "src/support.ts": `
      import { createAgent } from "eve";
      import { defineChannel, GET } from "eve/channels";
      import { defineTool } from "eve/tools";
      import { z } from "zod";
      import { greeting } from "./greeting.ts";
      export default createAgent({
        model: "openai/gpt-5.4",
        instructions: "Help Alice with greetings.",
        tools: {
          greet: defineTool({
            description: "Greet a person.",
            inputSchema: z.object({ name: z.string() }),
            execute: ({ name }) => greeting(name),
          }),
        },
        channels: {
          probe: defineChannel({
            routes: [GET("/probe", () => Response.json({ greeting: greeting("Alice") }))],
          }),
        },
      });
    `,
    "src/greeting.ts": "export const greeting = (name: string) => `Hello ${name}`;\n",
    "agent/agent.ts": `throw new Error("${ADJACENT_FAILURE}");\n`,
    "agent/tools/unselected.ts": `throw new Error("${ADJACENT_FAILURE}");\n`,
    "instrumentation/probe.ts": `throw new Error("${ADJACENT_FAILURE}");\n`,
  },
};

async function fetchProbe(serverUrl: string): Promise<unknown> {
  const response = await fetch(new URL("/probe", serverUrl), {
    signal: AbortSignal.timeout(10_000),
  });
  return response.ok ? await response.json() : { status: response.status };
}

function eveBin(appRoot: string): string {
  return join(appRoot, "node_modules", "eve", "bin", "eve.js");
}

function runEve(appRoot: string, args: readonly string[]) {
  const child = spawn(process.execPath, [eveBin(appRoot), ...args], {
    cwd: appRoot,
    env: { ...process.env, NODE_ENV: "test", ...SELECTION_ENV },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  return { child, output: () => output };
}

async function waitForExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

describe("entry-selected hosting", () => {
  it(
    "serves and reloads the selected entry under eve dev without loading adjacent sources",
    async () => {
      const app = await scenarioApp(ENTRY_HOST_DESCRIPTOR);
      const server = await startEveDev(app.appRoot, { env: SELECTION_ENV });
      const output = () => `stdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`;

      try {
        const info = await fetchAgentInfo(server.url);
        expect(info.agent.name).toBe("support");
        expect(info.tools.static.map((tool) => tool.name)).toContain("greet");
        expect(info.tools.static.map((tool) => tool.name)).not.toContain("unselected");
        await expect(fetchProbe(server.url)).resolves.toEqual({ greeting: "Hello Alice" });

        await writeFile(
          join(app.appRoot, "src/greeting.ts"),
          "export const greeting = (name: string) => `Hi ${name}`;\n",
        );
        await waitForCondition(
          async () => JSON.stringify(await fetchProbe(server.url)) === '{"greeting":"Hi Alice"}',
          () => `Transitive entry import edit was not published.\n\n${output()}`,
        );
        expect(output()).not.toContain(ADJACENT_FAILURE);
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );

  it(
    "builds the selected entry and starts it without the authored source",
    async () => {
      const app = await scenarioApp(ENTRY_HOST_DESCRIPTOR);
      const build = runEve(app.appRoot, ["build", "--skip-sandbox-prewarm"]);
      expect(await waitForExit(build.child), build.output()).toBe(0);
      await rename(join(app.appRoot, "src"), join(app.appRoot, "unavailable-source"));

      const start = runEve(app.appRoot, ["start", "--host", "127.0.0.1", "--port", "0"]);
      try {
        let url: string | undefined;
        await waitForCondition(
          () => {
            url = /server listening at (https?:\/\/\S+)/.exec(start.output())?.[1];
            return url !== undefined || start.child.exitCode !== null;
          },
          () => `eve start did not report a URL.\n${start.output()}`,
        );
        expect(url, start.output()).toBeDefined();
        await expect(fetchProbe(url!)).resolves.toEqual({ greeting: "Hello Alice" });
        expect(`${build.output()}\n${start.output()}`).not.toContain(ADJACENT_FAILURE);
      } finally {
        start.child.kill("SIGTERM");
        await waitForExit(start.child);
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );
});
