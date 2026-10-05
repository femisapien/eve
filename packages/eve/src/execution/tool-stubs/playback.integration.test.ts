import { describe, expect, it } from "vitest";
import { start } from "#internal/workflow/runtime.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { workflowEntry } from "#execution/session/entry.js";
import { callToolStubStep, readStubFailure } from "#execution/tool-stubs/steps.js";
import { STUB_CONTEXT_KEY } from "#tool-stubs/types.js";

describe("durable tool stub playback", () => {
  it("allocates concurrent calls once and reuses an earlier result after later workflow resumes", async () => {
    const runtime = await createTestRuntime({ agent: { name: "stub-playback" } });
    await runtime.run(async () => {
      const rules = [
        { id: "list", tool: "list_tasks", responses: [["milk", "dog"], ["dog"]] },
      ] as const;
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: {},
          serializedContext: {
            ...buildSerializedContext({ channelKind: "http" }),
            [STUB_CONTEXT_KEY]: { owner: "alice", token: "test-stub-playback", rules },
          },
        },
      ]);
      await waitForHook({ runId: run.runId }, { token: "test-stub-playback" });
      const scope = {
        owner: "alice",
        token: "test-stub-playback",
        rootSessionId: run.runId,
        rules,
      };
      const call = { tool: "list_tasks", input: {} };
      const outputs = await Promise.all([
        callToolStubStep(scope, { ...call, callId: "root:first" }),
        callToolStubStep(scope, { ...call, callId: "child:second" }),
      ]);
      expect(
        outputs.map((result) => (result.kind === "stub" ? result.position : null)).sort(),
      ).toEqual([0, 1]);
      expect(await callToolStubStep(scope, { ...call, callId: "root:first" })).toEqual(outputs[0]);
      expect(await callToolStubStep(scope, { ...call, callId: "root:third" })).toEqual({
        kind: "stub",
        ruleId: "list",
        position: 1,
        response: ["dog"],
      });
      expect(await readStubFailure(run.runId)).toBeUndefined();
    });
  });
});
