import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";

const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
const DEVELOPMENT_ALLOWED_HOSTS = ["localhost:*", "127.0.0.1:*"];

function getAllowedHosts(): string[] {
  if (process.env.NODE_ENV === "development") {
    return DEVELOPMENT_ALLOWED_HOSTS;
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
  if (process.env.NODE_ENV === "development") return `development-${name}`;
  throw new Error(`Missing required environment variable: ${name}`);
}

export const auth = betterAuth({
  baseURL: {
    allowedHosts: getAllowedHosts(),
    protocol: process.env.NODE_ENV === "development" ? "auto" : "https",
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
  // Better Auth filters input:false fields from OAuth profile mapping too.
  // Accept this field internally, but reject any attempt to set it via an API body.
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.body && Object.hasOwn(ctx.body, "vercelSubject")) {
        throw new APIError("BAD_REQUEST", { message: "Account identity is provider-managed." });
      }
    }),
  },
  user: {
    additionalFields: {
      vercelSubject: { type: "string", required: false },
    },
  },
  socialProviders: {
    vercel: {
      mapProfileToUser: (profile) => ({ vercelSubject: profile.sub }),
      clientId: requireEnvironmentVariable("VERCEL_APP_CLIENT_ID"),
      clientSecret: requireEnvironmentVariable("VERCEL_APP_CLIENT_SECRET"),
    },
  },
});
