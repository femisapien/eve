---
"eve": patch
---

Detect Vercel build output under `.vercel/build-output` so generated eve services are included in deployments instead of returning 404. Output discovery checks both supported layouts at each ancestor and selects the nearest build manifest.
