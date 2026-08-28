import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeExeClientLayer, ExeClient, normalizeVmList } from "../src/exe-client.js";
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
