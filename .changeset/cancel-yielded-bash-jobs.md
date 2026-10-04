---
"eve": patch
---

Cancelling a turn now force-stops its sandbox commands with SIGKILL even after `bash` returned them as running, including subprocesses. Other agents' commands in a shared sandbox and commands deliberately detached by a normally completed turn keep running.
