---
name: exe-workspaces
description: Create and manage isolated bb workspaces backed by disposable exe.dev VM clones.
---

# exe.dev workspaces

Use `exe_doctor` before the first workspace for a project. Use `exe_create_workspace` when work should run on an isolated VM clone rather than the main machine.

Treat the returned root thread as the workspace owner. Call `exe_retain_workspace` before archiving if the VM must survive. Automatic cleanup starts only after the root thread is archived or deleted and the configured grace period elapses.

Use `exe_destroy_workspace` only for clean, archived workspaces. It deliberately has no force option. If deletion is blocked by repository changes, retain the workspace and tell the user; only a human can force deletion through `bb exe destroy --yes --force`.
