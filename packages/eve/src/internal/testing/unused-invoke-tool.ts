import type { InvokeToolFn } from "#channel/invoke-tool.js";

/** Route-args stand-in for tests whose routes never invoke a tool. */
export const unusedInvokeTool: InvokeToolFn = async (name) => {
  throw new Error(`This test's route args do not support invokeTool("${name}").`);
};
