---
"eve": patch
---

Channel route handlers now receive `describe()`, which returns the agent's name, description, and compiled tools and skills without the inspection detail of `GET /eve/v1/info`, and `readSkill(skill, path?)`, which reads one compiled skill file (the skill's entry file in any authored case by default, capped at 512 KiB, never following symlinks). Production builds copy the root agent's skill files into the server output as plain, non-public files, and `readSkill` reads them there.
