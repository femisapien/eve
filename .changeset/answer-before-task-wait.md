---
"eve": patch
---

When a new message asks the model something while its tasks work, the task instructions now tell it to answer before waiting, and a `task_wait` that returns results reminds it to answer any message it hasn't answered yet, so the question isn't lost behind the task's result.
