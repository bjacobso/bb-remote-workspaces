---
name: remote-workspaces
description: Create and manage isolated bb workspaces backed by Exe VM clones or Amika snapshot sandboxes.
---

# Remote workspaces

Use `remote_workspaces_doctor` before the first workspace for a project. Use `remote_workspaces_create_workspace` when work should run on an isolated VM clone rather than the main machine.

Treat the returned root thread as the workspace owner. Call `remote_workspaces_retain_workspace` before archiving if the VM must survive. Automatic cleanup starts only after the root thread is archived or deleted and the configured grace period elapses.

Use `remote_workspaces_destroy_workspace` only for clean, archived workspaces. It deliberately has no force option. If deletion is blocked by repository changes, retain the workspace and tell the user; only a human can force deletion through `bb remote-workspaces destroy --yes --force`.

The project selects `provider: "exe"` (default) or `"amika"`. Amika doctor validates the snapshot; repository and copied-identity checks happen at creation. Workspace records pin their provider and configuration for cleanup.
