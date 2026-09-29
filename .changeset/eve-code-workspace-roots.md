---
"eve": patch
---

`grep` and `apply_patch` in `eve/extensions/code` now work in sandboxes whose workspace is not `/workspace`, such as `/app`. `apply_patch` no longer requires a git checkout: `root` is optional and defaults to the workspace root. It also accepts unified-diff range headers such as `@@ -118,8 +118,8 @@` instead of failing to find them as context.
