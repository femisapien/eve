---
"eve": patch
---

When a new message asks the model something while its tasks work, the task instructions and the `task_wait` description now tell it to answer in the same response, before waiting, so the question isn't lost behind the task's result.
