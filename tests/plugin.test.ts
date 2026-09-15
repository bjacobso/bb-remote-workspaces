import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../server.js";

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { while (disposals.length) await disposals.pop()?.(); vi.unstubAllGlobals(); });

async function load() {
  const host = createFakePluginHost({ pluginId: "bb-remote-workspaces", agentSkillIds: ["remote-workspaces"] });
  plugin(host.bb); disposals.push(() => host.harness.lifecycle.dispose()); return host;
}

describe("bb extension runtime", () => {
  it("registers the complete headless surface", async () => {
    const host = await load();
    expect(host.harness.inspection.registrations.cli?.name).toBe("remote-workspaces");
    expect(host.harness.inspection.registrations.agentTools.map((tool) => tool.name)).toEqual([
      "remote_workspaces_create_workspace", "remote_workspaces_get_workspace", "remote_workspaces_list_workspaces", "remote_workspaces_retain_workspace", "remote_workspaces_destroy_workspace", "remote_workspaces_doctor",
    ]);
    expect(host.harness.inspection.registrations.services.map((service) => service.name)).toEqual(["workspace-reconciler"]);
    expect(host.harness.inspection.registrations.threadEventHandlers["thread.archived"]).toBe(1);
  });

  it("persists project configuration through Effect + SQLite", async () => {
    const host = await load();
    const configured = await host.harness.behavior.runCli(["project", "configure", "--project", "project-1", "--template", "gold", "--repo-path", "/srv/repo"]);
    expect(configured.exitCode).toBe(0);
    const shown = await host.harness.behavior.runCli(["project", "show", "--project", "project-1"]);
    expect(shown.exitCode).toBe(0);
    expect(JSON.parse(shown.stdout)).toMatchObject({ projectId: "project-1", templateVm: "gold", repoPath: "/srv/repo", serverMode: "connect" });
  });

  it("loads, overrides, and diffs a strict config file through the bb file API", async () => {
    const config = JSON.stringify({
      version: 1, templateVm: "gold", repoPath: "/srv/repo", server: { mode: "connect" },
      resources: { cpu: 4 }, cleanup: { graceMinutes: 30 },
    });
    const host = createFakePluginHost({
      pluginId: "bb-remote-workspaces", agentSkillIds: ["remote-workspaces"],
      sdk: { files: { read: async ({ path }) => ({ path, content: config, contentEncoding: "utf8" }) } },
    });
    plugin(host.bb); disposals.push(() => host.harness.lifecycle.dispose());

    const before = await host.harness.runCli(["project", "diff", "--project", "project-1", "--file", "bb-remote-workspaces.config.json"], { cwd: "/repo" });
    expect(JSON.parse(before.stdout)).toMatchObject({ configured: false, changed: true, filePath: "/repo/bb-remote-workspaces.config.json" });

    const configured = await host.harness.runCli(["project", "configure", "--project", "project-1", "--file", "bb-remote-workspaces.config.json", "--cpu", "8"], { cwd: "/repo" });
    expect(JSON.parse(configured.stdout)).toMatchObject({ templateVm: "gold", cpu: 8 });
    const overridden = await host.harness.runCli(["project", "diff", "--project", "project-1", "--file", "bb-remote-workspaces.config.json"], { cwd: "/repo" });
    expect(JSON.parse(overridden.stdout)).toMatchObject({ changed: true, changes: [expect.objectContaining({ path: "cpu", current: 8, desired: 4 })] });

    await host.harness.runCli(["project", "configure", "--project", "project-1", "--file", "bb-remote-workspaces.config.json"], { cwd: "/repo" });
    const clean = await host.harness.runCli(["project", "diff", "--project", "project-1", "--file", "bb-remote-workspaces.config.json"], { cwd: "/repo" });
    expect(JSON.parse(clean.stdout)).toMatchObject({ configured: true, changed: false, changes: [] });
    expect(host.harness.sdk.callsTo("files.read")[0]?.[0]).toMatchObject({ path: "/repo/bb-remote-workspaces.config.json" });
  });

  it("validates raw JSON-schema tool arguments with Effect Schema", async () => {
    const host = await load();
    const result = await host.harness.behavior.callAgentTool("remote_workspaces_get_workspace", { workspaceId: 42 });
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("parameters");
  });

  it("selects its tools and lifecycle skill for agent sessions", async () => {
    const host = await load();
    const context = {
      thread: { id: "thread-1", title: null, parentThreadId: null, sourceThreadId: null },
      project: { id: "project-1", kind: "standard" as const, name: "Project", gitRemoteUrl: null },
      environment: { id: "env-1", name: null, path: "/srv/repo", workspaceProvisionType: "unmanaged" as const, branchName: null },
      host: { id: "host-1", name: "Host" }, provider: { id: "codex", model: "gpt", capabilities: { supportsNativeUserQuestion: true } },
      origin: { kind: null, pluginId: null },
    };
    const selected = await host.harness.behavior.resolveAgentConfiguration(context);
    expect(selected.skills).toEqual(["remote-workspaces"]); expect(selected.tools).toHaveLength(6);
  });

  it("runs create and guarded destroy end to end through the custom runtime", async () => {
    let workspaceId = "";
    let workspaceVm = "";
    let scriptCalls = 0;
    const commands: string[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const command = String(init?.body ?? ""); commands.push(command);
      if (command === "ls") return new Response(JSON.stringify([{ name: workspaceVm, status: "running", tags: ["bb-remote-workspaces"], comment: `bb-remote-workspaces workspace=${workspaceId} project=project-1` }]));
      if (command.includes("base64 -d")) {
        scriptCalls += 1;
        const output = scriptCalls === 1
          ? { clean: true, baseSha: "abc123", branch: "bb-remote-workspaces/test", copiedBbIdentityCount: 0 }
          : { clean: true, ahead: 0, markerMatches: true, branch: "bb-remote-workspaces/test", headSha: "abc123" };
        return new Response(JSON.stringify({ stdout: JSON.stringify(output) }));
      }
      return new Response("{}");
    });
    const host = createFakePluginHost({
      pluginId: "bb-remote-workspaces", agentSkillIds: ["remote-workspaces"], settings: { exeToken: "exe0.token" },
      sdk: {
        hosts: {
          createJoinCode: async () => ({ hostId: "host-1", joinCode: "JOIN", expiresAt: Date.now() + 60_000 }),
          get: async () => ({ status: "connected" }), update: async () => ({}), delete: async () => ({ ok: true }),
        },
        threads: { spawn: async () => ({ id: "thread-1", environmentId: "env-1" }), list: async () => [] },
        terminals: { list: async () => ({ sessions: [] }) },
        environments: { archiveThreads: async () => ({}) },
      },
    });
    plugin(host.bb); disposals.push(() => host.harness.lifecycle.dispose());
    expect((await host.harness.runCli(["project", "configure", "--project", "project-1", "--template", "gold", "--repo-path", "/srv/repo", "--server-url", "https://bb.example.com"])).exitCode).toBe(0);
    const createdResult = await host.harness.runCli(["create", "--project", "project-1", "--prompt", "Do work"]);
    expect(createdResult.stderr).toBe("");
    expect(createdResult).toMatchObject({ exitCode: 0 });
    const created = JSON.parse(createdResult.stdout) as { id: string; state: string; vmName: string };
    workspaceId = created.id; workspaceVm = created.vmName; expect(created.state).toBe("ready");
    const destroyed = await host.harness.runCli(["destroy", "--id", workspaceId, "--yes"]);
    expect(destroyed.exitCode).toBe(0); expect(JSON.parse(destroyed.stdout)).toMatchObject({ state: "deleted" });
    expect(commands.some((command) => command.startsWith("cp gold"))).toBe(true);
    expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(host.harness.sdk.callsTo("hosts.delete")).toHaveLength(1);
  });
});
