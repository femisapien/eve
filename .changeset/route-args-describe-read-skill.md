---
"eve": patch
---

Channel route handlers now receive `describe()`, which returns the agent's name, description, and compiled tools and skills without the inspection detail of `GET /eve/v1/info`, and `readSkill(skill, path?)`, which reads one compiled skill file (`SKILL.md` by default, capped at 512 KiB). Production builds embed the root agent's skill files in a lazily loaded chunk, up to 8 MiB in total; files past that budget are listed but not readable, and the build warns about them.
