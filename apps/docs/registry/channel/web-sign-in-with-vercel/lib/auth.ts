import { betterAuth } from "better-auth";

const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
export const skipLocalAuth =
  process.env.NODE_ENV === "development" &&
  (!process.env.VERCEL || process.env.VERCEL_ENV === "development") &&
  process.env.EVE_WEB_CHAT_SKIP_AUTH === "1";

const localUrl = new URL(process.env.EVE_WEB_CHAT_LOCAL_URL ?? "http://localhost:3000");

function getAllowedHosts(): string[] {
  if (process.env.NODE_ENV === "development") {
    return [localUrl.host];
  }
  const deploymentHosts = [
    process.env.VERCEL_URL,
    process.env.VERCEL_BRANCH_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
  ].filter((host): host is string => Boolean(host));
  if (deploymentHosts.length === 0) {
    throw new Error("No trusted deployment hosts are configured");
  }
  return Array.from(new Set(deploymentHosts));
}

function requireEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (value) return value;
  if (skipLocalAuth) return `development-${name}`;
  throw new Error(`Missing required environment variable: ${name}`);
}

export const auth = betterAuth({
  baseURL: {
    allowedHosts: getAllowedHosts(),
    protocol:
      process.env.NODE_ENV === "development" && localUrl.protocol === "http:" ? "http" : "https",
  },
  secret: requireEnvironmentVariable("BETTER_AUTH_SECRET"),
  session: {
    expiresIn: SESSION_MAX_AGE_SECONDS,
    disableSessionRefresh: true,
    cookieCache: {
      enabled: true,
      maxAge: SESSION_MAX_AGE_SECONDS,
      refreshCache: false,
      strategy: "jwe",
    },
  },
  socialProviders: {
    vercel: {
      clientId: requireEnvironmentVariable("VERCEL_APP_CLIENT_ID"),
      clientSecret: requireEnvironmentVariable("VERCEL_APP_CLIENT_SECRET"),
      scope: ["openid", "email", "profile"],
    },
  },
});
