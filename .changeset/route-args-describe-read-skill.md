---
"eve": patch
---

Channel route handlers now receive `describe()`, which returns the agent's name, description, and compiled tools and skills without the inspection detail of `GET /eve/v1/info`, and `readSkill(skill, path?)`, which reads one compiled skill file (the skill's entry file in any authored case by default, capped at 512 KiB, never following symlinks). Production builds bundle the root agent's skill files byte for byte as Nitro server assets, and `readSkill` reads them through `useStorage("assets:eve-skills")`, checked against a build-time index of real paths, sizes, and SHA-256 digests.
