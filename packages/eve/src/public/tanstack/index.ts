import { isAbsolute, resolve } from "node:path";

import type { Plugin, UserConfig } from "vite";

import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";
import { resolveSharedEveDevServer, type EveFrameworkHost } from "#shared/framework-eve-server.js";
import {
  ensureEveVercelServicesConfig,
  mergeEveVercelConfig,
  type VercelBuildConfig,
} from "#shared/vercel-services.js";

const EVE_BASE_URL_ENV = "EVE_BASE_URL";
const EVE_TANSTACK_HOST: EveFrameworkHost = { label: "TanStack Start", slug: "tanstack" };

/**
 * Options for the eve TanStack Start Vite plugin.
 */
export interface EveTanStackPluginOptions {
  /**
   * Path to the eve application root, relative to the TanStack Start project
   * root unless absolute. Defaults to the TanStack Start project root.
   */
  readonly eveRoot?: string;
  /**
   * Command that builds the eve app inside the generated Vercel eve service.
   * Defaults to running the installed eve binary from the TanStack Start
   * app's dependencies (`node <path-to>/eve/bin/eve.js build`).
   */
  readonly eveBuildCommand?: string;
}

/**
 * The slice of Nitro's `nitro` Vite config key this plugin writes. It is typed
 * locally so eve does not depend on Nitro's Vite type augmentation.
 */
type NitroUserConfig = UserConfig & {
  readonly nitro?: {
    readonly routeRules?: Record<string, { readonly proxy: string }>;
    readonly vercel?: { readonly config: VercelBuildConfig };
  };
};

function resolveApplicationRoot(hostRoot: string, appPath: string | undefined): string {
  if (appPath === undefined || appPath.length === 0) {
    return hostRoot;
  }
  return isAbsolute(appPath) ? appPath : resolve(hostRoot, appPath);
}

async function resolveEveDevOrigin(appRoot: string): Promise<string> {
  const configuredEveBaseUrl = process.env[EVE_BASE_URL_ENV]?.trim();
  if (configuredEveBaseUrl && configuredEveBaseUrl.length > 0) {
    return new URL(configuredEveBaseUrl).origin;
  }

  return (await resolveSharedEveDevServer({ appRoot, host: EVE_TANSTACK_HOST })).origin;
}

/**
 * Vite plugin for running an eve agent alongside a TanStack Start app.
 *
 * TanStack Start reaches Vercel through Nitro, so the app must register
 * `nitro()` from `nitro/vite`; `eveTanStack` configures Nitro to route eve.
 *
 * In development, Nitro proxies eve protocol endpoints to a local eve server.
 * It resolves the server in order: the `EVE_BASE_URL` env var if set, then a
 * healthy shared eve dev server already running for the app, then a freshly
 * spawned `eve dev --no-ui --port 0`.
 *
 * On Vercel builds, `eveTanStack` adds the eve runtime as a sibling Vercel
 * service and routes its transport requests before TanStack Start's own
 * routing.
 */
export function eveTanStack(options: EveTanStackPluginOptions = {}): Plugin {
  return {
    name: "eve:tanstack",
    enforce: "pre",
    async config(config, env): Promise<NitroUserConfig> {
      if (env.isPreview) {
        return {};
      }

      const hostRoot = resolve(process.cwd(), config.root ?? ".");
      const appRoot = resolveApplicationRoot(hostRoot, options.eveRoot);

      if (env.command === "serve") {
        const origin = await resolveEveDevOrigin(appRoot);
        // Vite's own `server.proxy` never runs: Nitro answers dev requests
        // before Vite's proxy middleware.
        return {
          nitro: {
            routeRules: {
              [`${EVE_ROUTE_PREFIX}/**`]: { proxy: `${origin}${EVE_ROUTE_PREFIX}/**` },
            },
          },
        };
      }

      if (!process.env.VERCEL) {
        return {};
      }

      const configured = await ensureEveVercelServicesConfig({
        appRoot,
        eveBuildCommand: options.eveBuildCommand,
        frameworkName: "TanStack Start",
        hostRoot,
      });

      // Nitro merges `vercel.config` into the Build Output config it writes,
      // placing the eve route ahead of its own filesystem handler.
      return configured.mode === "generated"
        ? { nitro: { vercel: { config: mergeEveVercelConfig(undefined, configured) } } }
        : {};
    },
    configResolved(config) {
      // The `nitro` config key above is only read by Nitro's Vite plugin.
      // Without it the eve routes would silently 404.
      if (!config.plugins.some((plugin) => plugin.name.startsWith("nitro:"))) {
        throw new Error(
          'eveTanStack() needs the Nitro Vite plugin. Install "nitro" and add nitro() from "nitro/vite" to the plugins in vite.config.ts.',
        );
      }
    },
  };
}
