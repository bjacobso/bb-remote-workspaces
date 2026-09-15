import Database from "better-sqlite3";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { makeAmikaClient } from "../src/amika-client.js";
import { BbPlatform, type BbPlatformShape } from "../src/bb-platform.js";
import { Orchestrator, OrchestratorLive } from "../src/orchestrator.js";
import { WorkspaceProviders, type WorkspaceProvider } from "../src/providers.js";
import { makeWorkspaceStoreLayer } from "../src/store.js";
import { normalizeProjectConfig } from "../src/types.js";

const config = () => Effect.runPromise(normalizeProjectConfig({ projectId: "p", provider: "amika", templateVm: "snapshot", repoPath: "/repo" }));

describe("Amika provider", () => {
  it("creates from a snapshot, waits for readiness, executes scripts, and deletes by immutable id", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const runSsh = vi.fn(async (_args: string[], _token: string, _signal: AbortSignal) => 'progress\n{"ok":true}\n');
    const provider = makeAmikaClient({ getToken: Effect.succeed("amika-secret"), runSsh,
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init! });
        return Response.json(init?.method === "DELETE" ? { ok: true } : { id: "sandbox-id", name: "workspace", status: "running", setup_status: "ok" });
      },
    });
    expect(await Effect.runPromise(provider.copyVm("snapshot", "workspace", await config()))).toBe("sandbox-id");
    await Effect.runPromise(provider.markVm("workspace", "w", "p"));
    expect(await Effect.runPromise(provider.runScript("workspace", "echo script", ["it's a path"], Schema.Struct({ ok: Schema.Boolean })))).toEqual({ ok: true });
    await Effect.runPromise(provider.removeVm("workspace", "sandbox-id"));
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ name: "workspace", snapshot: "snapshot", auto_stop_interval: 0, auto_delete_interval: -1 });
    expect(calls.at(-1)?.url).toBe("https://app.amika.dev/api/v0beta1/sandboxes/sandbox-id");
    expect(runSsh.mock.calls[0]).toEqual([expect.arrayContaining(["sandbox", "--remote", "ssh", "BatchMode=yes", "workspace"]), "amika-secret", expect.any(AbortSignal)]);
    expect(JSON.stringify(runSsh.mock.calls[0]?.[0])).not.toContain("amika-secret");
  });

  it("rejects absent credentials, malformed inventory, provisioning failures, and nonzero SSH exits", async () => {
    const fetch = vi.fn(async () => Response.json({ unexpected: true }));
    const missing = makeAmikaClient({ getToken: Effect.succeed(undefined), fetch });
    await expect(Effect.runPromise(missing.whoami)).rejects.toMatchObject({ code: "missing_amika_token" });
    expect(fetch).not.toHaveBeenCalled();
    const malformed = makeAmikaClient({ getToken: Effect.succeed("secret"), fetch });
    await expect(Effect.runPromise(malformed.listVms)).rejects.toMatchObject({ code: "invalid_input" });
    const failed = makeAmikaClient({ getToken: Effect.succeed("secret"), fetch: async () => Response.json({ id: "id", name: "w", status: "failed" }), runSsh: async () => { throw new Error("secret --join-code sensitive"); } });
    await expect(Effect.runPromise(failed.markVm("w", "id", "p"))).rejects.toMatchObject({ code: "amika_provision_failed" });
    await expect(Effect.runPromise(failed.runCommand("w", "false"))).rejects.toMatchObject({ code: "amika_ssh_failed", message: expect.not.stringContaining("sensitive") });
    const unavailable = makeAmikaClient({ getToken: Effect.succeed("secret"), fetch: async () => new Response("secret", { status: 503 }) });
    await expect(Effect.runPromise(unavailable.whoami)).rejects.toMatchObject({ retryable: true, message: expect.not.stringContaining("secret") });
  });

  it("rejects unsupported resource overrides before provisioning", async () => {
    await expect(Effect.runPromise(normalizeProjectConfig({ projectId: "p", provider: "amika", templateVm: "snapshot", repoPath: "/repo", cpu: 4 }))).rejects.toMatchObject({ code: "invalid_project_config" });
  });
});

it("pins the Amika provider and repo for guarded cleanup after switching the project to Exe", async () => {
  const db = new Database(":memory:");
  let sandboxName = "";
  let sandboxId = "amika-id";
  let clean = true;
  const deleted: string[] = [];
  const ssh: string[][] = [];
  const amika = makeAmikaClient({
    getToken: Effect.succeed("secret"),
    fetch: async (_url, init) => {
      if (init?.method === "POST") {
        sandboxName = JSON.parse(String(init.body)).name;
        return Response.json({ id: sandboxId, name: sandboxName, status: "running" });
      }
      if (init?.method === "DELETE") { deleted.push(String(_url)); return Response.json({ ok: true }); }
      const sandbox = { id: sandboxId, name: sandboxName, status: "running" };
      return Response.json(String(_url).endsWith("/sandboxes") ? [sandbox] : sandbox);
    },
    runSsh: async args => {
      ssh.push(args);
      return JSON.stringify({ clean, ahead: 0, markerMatches: true, baseSha: "sha", branch: "branch", headSha: "sha", copiedBbIdentityCount: 0 });
    },
  });
  const exe = new Proxy({} as WorkspaceProvider, { get: () => { throw new Error("Wrong provider used"); } });
  const bb: BbPlatformShape = {
    enrollHost: () => Effect.succeed({ hostId: "h", joinCode: "j", serverUrl: "https://bb.example.com", machineCode: null }),
    waitForHost: () => Effect.void, spawnThread: () => Effect.succeed({ id: "t", environmentId: "e" }),
    getThread: () => Effect.succeed({ archived: true }), inspectEnvironment: () => Effect.succeed({ safe: true, openThreadIds: [], activeTerminalIds: [] }),
    archiveEnvironment: () => Effect.void, deleteHost: () => Effect.void, readTextFile: () => Effect.succeed(""), logInfo: () => Effect.void, logError: () => Effect.void,
  };
  const layer = OrchestratorLive.pipe(Layer.provide(Layer.mergeAll(
    makeWorkspaceStoreLayer(db, (database, statements) => statements.forEach(sql => database.exec(sql))),
    Layer.succeed(BbPlatform, bb), Layer.succeed(WorkspaceProviders, { exe, amika }),
  )));
  try {
    await Effect.runPromise(Effect.gen(function*() {
      const o = yield* Orchestrator;
      yield* o.configureProject({ projectId: "p", provider: "amika", templateVm: "snapshot", repoPath: "/original-repo" });
      const created = yield* o.create({ projectId: "p", prompt: "work" });
      expect(created).toMatchObject({ state: "ready", provider: "amika", providerResourceId: "amika-id" });
      yield* o.configureProject({ projectId: "p", provider: "exe", templateVm: "gold", repoPath: "/different-repo" });
      sandboxId = "imposter";
      const ownershipError = yield* o.destroy({ workspaceId: created.id, force: true }).pipe(Effect.flip);
      expect(ownershipError.code).toBe("provider_ownership_mismatch");
      sandboxId = "amika-id";
      clean = false;
      const dirtyError = yield* o.destroy({ workspaceId: created.id }).pipe(Effect.flip);
      expect(dirtyError.code).toBe("workspace_not_safe");
      expect(deleted).toHaveLength(0);
      clean = true;
      yield* o.scheduleCleanupForThread("t");
      const scheduled = yield* o.get(created.id);
      // Move the persisted cleanup deadline into the past, as on a later reconciliation pass.
      db.prepare("UPDATE workspaces SET payload=? WHERE id=?").run(JSON.stringify({ ...scheduled, cleanupAfter: 0 }), created.id);
      yield* o.reconcile;
      expect((yield* o.get(created.id)).state).toBe("deleted");
      expect(deleted).toEqual(["https://app.amika.dev/api/v0beta1/sandboxes/amika-id"]);
      expect(ssh.at(-1)?.at(-1)).toContain("/original-repo");
      expect(ssh.at(-1)?.at(-1)).not.toContain("/different-repo");
    }).pipe(Effect.provide(layer)));
  } finally { db.close(); }
});
