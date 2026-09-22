---
"eve": patch
---

Write fallback Vercel service configuration under the Next.js app directory in linked monorepos. This keeps generated eve services discoverable when no active build output directory is found, preventing deployments that omit the agent endpoints.
