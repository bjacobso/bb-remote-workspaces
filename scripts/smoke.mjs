import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

if (process.env.BB_REMOTE_WORKSPACES_SMOKE !== "1") {
  throw new Error("Refusing to create a real VM. Set BB_REMOTE_WORKSPACES_SMOKE=1 to confirm this smoke test may create billable provider resources.");
}

const projectId = process.env.BB_REMOTE_WORKSPACES_SMOKE_PROJECT;
if (!projectId) throw new Error("BB_REMOTE_WORKSPACES_SMOKE_PROJECT is required.");
const configFile = resolve(process.env.BB_REMOTE_WORKSPACES_SMOKE_CONFIG ?? "bb-remote-workspaces.config.json");
const waitSeconds = process.env.BB_REMOTE_WORKSPACES_SMOKE_TIMEOUT ?? "1200";
const keep = process.env.BB_REMOTE_WORKSPACES_SMOKE_KEEP === "1";
let workspace;

function bb(args) {
  process.stderr.write(`$ bb ${args.join(" ")}\n`);
  return execFileSync("bb", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

function plugin(args) {
  return JSON.parse(bb(["plugin", "run", "bb-remote-workspaces", ...args]));
}

try {
  plugin(["project", "configure", "--project", projectId, "--file", configFile]);
  const doctor = plugin(["project", "doctor", "--project", projectId]);
  if (!doctor.ok) throw new Error(`Doctor failed: ${JSON.stringify(doctor.checks)}`);

  workspace = plugin(["create", "--project", projectId, "--prompt", "Reply exactly bb-remote-workspaces-smoke-ready. Do not modify files.", "--title", "bb-remote-workspaces smoke test"]);
  process.stderr.write(`Created workspace ${workspace.id}, thread ${workspace.rootThreadId}, VM ${workspace.vmName}.\n`);
  bb(["thread", "wait", workspace.rootThreadId, "--status", "idle", "--timeout", waitSeconds, "--json"]);
  bb(["thread", "archive", workspace.rootThreadId, "--json"]);

  if (keep) {
    plugin(["retain", "--id", workspace.id, "--reason", "BB_REMOTE_WORKSPACES_SMOKE_KEEP=1"]);
    process.stderr.write(`Smoke test passed; retained workspace ${workspace.id}.\n`);
  } else {
    const deleted = plugin(["destroy", "--id", workspace.id, "--yes"]);
    if (deleted.state !== "deleted") throw new Error(`Unexpected final state: ${deleted.state}`);
    process.stderr.write(`Smoke test passed; deleted workspace ${workspace.id}.\n`);
  }
} catch (error) {
  if (workspace?.id) {
    try {
      plugin(["retain", "--id", workspace.id, "--reason", "real smoke test failed; retained for diagnosis"]);
      process.stderr.write(`Retained failed workspace ${workspace.id} for diagnosis.\n`);
    } catch {
      process.stderr.write(`Could not retain workspace ${workspace.id}; inspect it manually.\n`);
    }
  }
  throw error;
}
