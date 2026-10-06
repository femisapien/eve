import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigEnv, Plugin, ResolvedConfig, UserConfig } from "vite";

import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";
import { resolveSharedEveDevServer } from "#shared/framework-eve-server.js";
import { ensureEveVercelServicesConfig, mergeEveVercelConfig } from "#shared/vercel-services.js";

import { eveTanStack } from "./index.js";

vi.mock("#shared/framework-eve-server.js", () => ({
  resolveSharedEveDevServer: vi.fn(async () => ({ origin: "http://127.0.0.1:49152" })),
}));

vi.mock("#shared/vercel-services.js", () => ({
  ensureEveVercelServicesConfig: vi.fn(async () => ({ mode: "root" })),
  mergeEveVercelConfig: vi.fn(() => ({ routes: [], services: {}, version: 3 })),
}));

const resolveSharedEveDevServerMock = vi.mocked(resolveSharedEveDevServer);
const ensureEveVercelServicesConfigMock = vi.mocked(ensureEveVercelServicesConfig);
const mergeEveVercelConfigMock = vi.mocked(mergeEveVercelConfig);

type ConfigHook = (config: UserConfig, env: ConfigEnv) => Promise<unknown>;
type ConfigResolvedHook = (config: ResolvedConfig) => void;

function getConfigHook(plugin: Plugin): ConfigHook {
  if (typeof plugin.config !== "function") {
    throw new Error("expected plugin config hook");
  }
  return plugin.config as ConfigHook;
}

function getConfigResolvedHook(plugin: Plugin): ConfigResolvedHook {
  if (typeof plugin.configResolved !== "function") {
    throw new Error("expected plugin configResolved hook");
  }
  return plugin.configResolved as ConfigResolvedHook;
}

function resolvedConfigWithPlugins(...names: string[]): ResolvedConfig {
  const config: Partial<ResolvedConfig> = { plugins: names.map((name) => ({ name })) };
  return config as ResolvedConfig;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("eveTanStack", () => {
  it("proxies eve routes through Nitro to a shared eve dev server", async () => {
    const result = await getConfigHook(eveTanStack())(
      {},
      { command: "serve", mode: "development" },
    );

    expect(resolveSharedEveDevServerMock).toHaveBeenCalledWith({
      appRoot: process.cwd(),
      host: { label: "TanStack Start", slug: "tanstack" },
    });
    expect(result).toEqual({
      nitro: {
        routeRules: {
          [`${EVE_ROUTE_PREFIX}/**`]: { proxy: `http://127.0.0.1:49152${EVE_ROUTE_PREFIX}/**` },
        },
      },
    });
  });

  it("prefers EVE_BASE_URL over spawning a shared server", async () => {
    vi.stubEnv("EVE_BASE_URL", "https://agent.example.com/root");

    const result = await getConfigHook(eveTanStack())(
      {},
      { command: "serve", mode: "development" },
    );

    expect(resolveSharedEveDevServerMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      nitro: {
        routeRules: {
          [`${EVE_ROUTE_PREFIX}/**`]: {
            proxy: `https://agent.example.com${EVE_ROUTE_PREFIX}/**`,
          },
        },
      },
    });
  });

  it("resolves eveRoot against the Vite root", async () => {
    await getConfigHook(eveTanStack({ eveRoot: "agent" }))(
      { root: "/projects/web" },
      { command: "serve", mode: "development" },
    );

    expect(resolveSharedEveDevServerMock).toHaveBeenCalledWith(
      expect.objectContaining({ appRoot: "/projects/web/agent" }),
    );
  });

  it("does not start eve for local production preview", async () => {
    const result = await getConfigHook(eveTanStack())(
      {},
      { command: "serve", isPreview: true, mode: "production" },
    );

    expect(resolveSharedEveDevServerMock).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });

  it("generates nothing outside Vercel builds", async () => {
    const result = await getConfigHook(eveTanStack())({}, { command: "build", mode: "production" });

    expect(ensureEveVercelServicesConfigMock).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });

  it("adds the generated eve service to Nitro's Vercel config on Vercel builds", async () => {
    vi.stubEnv("VERCEL", "1");
    const generated = { mode: "generated", services: {} } as const;
    ensureEveVercelServicesConfigMock.mockResolvedValueOnce(generated);

    const result = await getConfigHook(
      eveTanStack({ eveBuildCommand: "pnpm build:eve", eveRoot: "agent" }),
    )({ root: "/projects/web" }, { command: "build", mode: "production" });

    expect(ensureEveVercelServicesConfigMock).toHaveBeenCalledWith({
      appRoot: "/projects/web/agent",
      eveBuildCommand: "pnpm build:eve",
      frameworkName: "TanStack Start",
      hostRoot: "/projects/web",
    });
    expect(mergeEveVercelConfigMock).toHaveBeenCalledWith(undefined, generated);
    expect(result).toEqual({
      nitro: { vercel: { config: { routes: [], services: {}, version: 3 } } },
    });
  });

  it("leaves routing to the user's services config when vercel.json declares services", async () => {
    vi.stubEnv("VERCEL", "1");

    const result = await getConfigHook(eveTanStack())({}, { command: "build", mode: "production" });

    expect(mergeEveVercelConfigMock).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });

  it("fails fast when the Nitro Vite plugin is missing", () => {
    const hook = getConfigResolvedHook(eveTanStack());

    expect(() => hook(resolvedConfigWithPlugins("vite:react-babel"))).toThrow(
      /nitro\(\) from "nitro\/vite"/,
    );
    expect(() => hook(resolvedConfigWithPlugins("nitro:main", "nitro:init"))).not.toThrow();
  });
});
