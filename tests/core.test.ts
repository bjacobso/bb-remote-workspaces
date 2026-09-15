import { Effect } from "effect";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeExeClientLayer, ExeClient, normalizeVmList } from "../src/exe-client.js";
import { consumerConfigToInput, diffProjectConfig, parseConsumerProjectConfig } from "../src/config-file.js";
import { redactSecrets } from "../src/errors.js";
import { formatCommand, quoteShellArgument } from "../src/shell.js";
import { normalizeProjectConfig } from "../src/types.js";

describe("command safety", () => {
  it("quotes shell arguments and rejects controls", () => {
    expect(quoteShellArgument("hello world")).toBe("'hello world'");
    expect(quoteShellArgument("it's-safe")).toBe("'it'\"'\"'s-safe'");
    expect(formatCommand(["ssh", "vm one"])).toBe("ssh 'vm one'");
    expect(() => quoteShellArgument("bad\narg")).toThrow("control characters");
  });

  it("redacts every enrollment secret shape", () => {
    const value = redactSecrets("Bearer exe0.secret --join-code ABC --machine-code=DEF");
    expect(value).not.toContain("secret"); expect(value).not.toContain("ABC"); expect(value).not.toContain("DEF");
  });
});

describe("Effect domain decoding", () => {
  it("normalizes and validates project configuration in the error channel", async () => {
    const config = await Effect.runPromise(normalizeProjectConfig({ projectId: "p", templateVm: "gold", repoPath: "/srv/repo" }, undefined, 10));
    expect(config).toMatchObject({ remoteName: "origin", baseBranch: "main", serverMode: "connect", cleanupGraceMinutes: 30, createdAt: 10 });
    await expect(Effect.runPromise(normalizeProjectConfig({ projectId: "p", templateVm: "gold", repoPath: "relative" }))).rejects.toMatchObject({ code: "invalid_project_config" });
  });
});

describe("config as code", () => {
  const content = JSON.stringify({
    version: 1, templateVm: "app-main", repoPath: "/workspace/app",
    server: { mode: "connect" }, resources: { cpu: 4, memory: "8GB" }, cleanup: { graceMinutes: 45 },
  });

  it("strictly decodes the versioned consumer shape and projects it into the domain input", async () => {
    const consumer = await Effect.runPromise(parseConsumerProjectConfig(content, "/repo/bb-remote-workspaces.config.json"));
    expect(consumerConfigToInput("project-1", consumer)).toEqual({
      projectId: "project-1", templateVm: "app-main", repoPath: "/workspace/app",
      serverMode: "connect", directServerUrl: null, cpu: 4, memory: "8GB", cleanupGraceMinutes: 45,
    });
  });

  it("rejects unknown keys so configuration typos cannot be silently ignored", async () => {
    await expect(Effect.runPromise(parseConsumerProjectConfig(JSON.stringify({ version: 1, templateVm: "app", repoPath: "/app", resoruces: {} }), "config.json")))
      .rejects.toMatchObject({ code: "invalid_config_file" });
  });

  it("reports only consumer-controlled changes", async () => {
    const desired = await Effect.runPromise(normalizeProjectConfig({ projectId: "p", templateVm: "new", repoPath: "/app" }, undefined, 20));
    const current = { ...desired, templateVm: "old", updatedAt: 10 };
    expect(diffProjectConfig("p", "/config.json", current, desired)).toMatchObject({
      configured: true, changed: true, changes: [{ path: "templateVm", current: "old", desired: "new" }],
    });
  });

  it("keeps every shipped example compatible with the Effect schema", async () => {
    for (const name of ["development", "large-test", "direct-server", "amika"]) {
      const content = readFileSync(new URL(`../examples/${name}.bb-remote-workspaces.config.json`, import.meta.url), "utf8");
      const consumer = await Effect.runPromise(parseConsumerProjectConfig(content, name));
      await expect(Effect.runPromise(normalizeProjectConfig(consumerConfigToInput("project", consumer)))).resolves.toMatchObject({ projectId: "project" });
    }
  });
});

describe("exe.dev Effect service", () => {
  it("normalizes API VM result variants", () => {
    expect(normalizeVmList({ vms: [{ vm_name: "gold", state: "running", tags: "one,two" }] })).toEqual([
      expect.objectContaining({ name: "gold", status: "running", tags: ["one", "two"] }),
    ]);
  });

  it("sends command language through a cancellable Effect boundary", async () => {
    const calls: Array<RequestInit> = [];
    const mockFetch: typeof fetch = async (_input, init) => { calls.push(init ?? {}); return new Response(JSON.stringify([{ name: "gold", status: "running" }]), { status: 200 }); };
    const layer = makeExeClientLayer({ getToken: Effect.succeed("exe0.token"), fetch: mockFetch });
    const result = await Effect.runPromise(Effect.flatMap(ExeClient, (client) => client.listVms).pipe(Effect.provide(layer)));
    expect(result[0]?.name).toBe("gold");
    expect(calls[0]?.body).toBe("ls");
    expect((calls[0]?.headers as Record<string, string>).authorization).toBe("Bearer exe0.token");
  });

  it("maps provider failures to retryable tagged errors without leaking tokens", async () => {
    const layer = makeExeClientLayer({ getToken: Effect.succeed("exe0.topsecret"), fetch: async () => new Response("Bearer exe0.topsecret failed", { status: 503 }) });
    await expect(Effect.runPromise(Effect.flatMap(ExeClient, (client) => client.whoami).pipe(Effect.provide(layer))))
      .rejects.toMatchObject({ code: "exe_api_error", retryable: true, message: expect.not.stringContaining("topsecret") });
  });
});
