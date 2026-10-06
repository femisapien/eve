import { withPhase } from "#setup/cli/index.js";
import type { VercelProjectReference } from "#setup/project-resolution.js";
import { installScaffoldDependencies } from "../shared/scaffold.js";
import type { SetupPresenter } from "../types.js";
import { provisionWebChatAuth } from "./provision-auth.js";

export interface WebAuthSetupDeps {
  provisionWebChatAuth: typeof provisionWebChatAuth;
  installScaffoldDependencies: typeof installScaffoldDependencies;
}

export async function setupWebAuth(
  input: {
    project: VercelProjectReference;
    environmentRoot: string;
    presenter: SetupPresenter;
    /** Existing apps apply their checked overlay after provisioning succeeds. */
    writeAuth?: () => Promise<void>;
    signal?: AbortSignal;
  },
  deps: WebAuthSetupDeps = { provisionWebChatAuth, installScaffoldDependencies },
): Promise<void> {
  await withPhase(input.presenter.log, "Configuring Sign in with Vercel…", () =>
    deps.provisionWebChatAuth(input.project, input.signal),
  );
  input.signal?.throwIfAborted();
  if (input.writeAuth !== undefined) {
    await input.writeAuth();
    await deps.installScaffoldDependencies({
      changed: true,
      required: true,
      log: input.presenter.log,
      projectPath: input.environmentRoot,
      signal: input.signal,
    });
  }
  input.presenter.log.success("Configured Sign in with Vercel for this project's team");
  input.presenter.nextSteps([
    "Created locally; not deployed yet. Run `eve deploy` to publish your Web Chat. Production and preview credentials are configured.",
    "Local development continues to use localDev() without signing in.",
  ]);
}
