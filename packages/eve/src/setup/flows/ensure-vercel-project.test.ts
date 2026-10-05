import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { HumanActionRequiredError } from "#setup/human-action.js";
import { WizardCancelledError } from "#setup/step.js";

import { ensureVercelProject } from "./ensure-vercel-project.js";
import { runLoginFlow } from "./login.js";

describe("ensureVercelProject", () => {
  it("logs in before reusing an existing project link", async () => {
    const project = { orgId: "team", projectId: "project" };
    const runLoginFlow = vi.fn(async () => ({ kind: "logged-in" as const }));
    const readProjectLink = vi.fn(async () => project);
    const { prompter } = createFakePrompter();

    await expect(
      ensureVercelProject({
        appRoot: "/project",
        prompter,
        deps: { readProjectLink, runLoginFlow },
      }),
    ).resolves.toBe(project);

    expect(runLoginFlow).toHaveBeenCalledWith({
      appRoot: "/project",
      prompter,
      signal: undefined,
      allowLogin: false,
    });
    expect(readProjectLink).toHaveBeenCalledOnce();
  });

  it("opens browser login when an interactive caller opts in", async () => {
    const project = { orgId: "team", projectId: "project" };
    const getVercelAuthStatus = vi
      .fn()
      .mockResolvedValueOnce("logged-out")
      .mockResolvedValueOnce("authenticated");
    const runVercelLogin = vi.fn(async () => true);

    await expect(
      ensureVercelProject({
        appRoot: "/project",
        prompter: createFakePrompter().prompter,
        allowLogin: true,
        deps: {
          readProjectLink: async () => project,
          runLoginFlow: (input) =>
            runLoginFlow({ ...input, deps: { getVercelAuthStatus, runVercelLogin } }),
          requireAuth: async () => {
            throw new HumanActionRequiredError({
              kind: "vercel-login",
              command: "vercel login",
              reason: "Login required",
            });
          },
        },
      }),
    ).resolves.toEqual(project);
    expect(runVercelLogin).toHaveBeenCalledOnce();
  });

  it("cancels before project selection when login is cancelled", async () => {
    const readProjectLink = vi.fn();

    await expect(
      ensureVercelProject({
        appRoot: "/project",
        prompter: createFakePrompter().prompter,
        deps: {
          readProjectLink,
          runLoginFlow: vi.fn(async () => ({ kind: "cancelled" as const })),
        },
      }),
    ).rejects.toBeInstanceOf(WizardCancelledError);

    expect(readProjectLink).not.toHaveBeenCalled();
  });
});
