---
"eve": patch
---

Channel route handlers now receive `describe()`, which returns the agent's name, description, and compiled tools and skills without the inspection detail of `GET /eve/v1/info`, and `readSkill(skill, path?)`, which reads one compiled skill file (`SKILL.md` by default, capped at 512 KiB).
