---
"eve": patch
---

Cancelling a turn now force-stops identifiable sandbox commands already returned as running while their original process remains alive, including subprocesses in the same process group; sibling agents' commands are unaffected. SIGKILL skips cleanup traps and records exit code 137; detached children and children that outlive their command require an explicit stop, as do commands left running by completed or failed turns.
