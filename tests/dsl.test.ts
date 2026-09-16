import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  cleanup,
  compute,
  defineSetup,
  environment,
  projectConfigInput,
  repository,
  server,
  synthesize,
  synthesizeJson,
} from "../src/dsl.js";

const app = repository({ path: "/workspace/app", base: "trunk" });
const standard = compute.exe({ template: "app-main", resources: { cpu: 4, memory: "8GB" } });
const setup = defineSetup({
  default: "development",
  environments: {
    development: environment({ compute: standard, repository: app }),
    review: environment({
      compute: compute.amika({ template: "app-snapshot" }),
      repository: app,
      server: server.direct("https://bb.example.com"),
      cleanup: cleanup({ graceMinutes: 60 }),
    }),
  },
});

describe("dev environment DSL", () => {
  it("synthesizes reusable compute primitives to the existing consumer format", async () => {
    await expect(Effect.runPromise(synthesize(setup))).resolves.toEqual({
      "$schema": "https://raw.githubusercontent.com/bjacobso/bb-remote-workspaces/main/schema.json",
      version: 1,
      provider: "exe",
      templateVm: "app-main",
      repoPath: "/workspace/app",
      remoteName: "origin",
      baseBranch: "trunk",
      server: { mode: "connect" },
      resources: { cpu: 4, memory: "8GB" },
      cleanup: { graceMinutes: 30 },
    });
  });

  it("selects named environments and compiles to an orchestrator input", async () => {
    await expect(Effect.runPromise(projectConfigInput(setup, "project-1", { environment: "review" }))).resolves.toEqual({
      projectId: "project-1",
      provider: "amika",
      templateVm: "app-snapshot",
      repoPath: "/workspace/app",
      remoteName: "origin",
      baseBranch: "trunk",
      serverMode: "direct",
      directServerUrl: "https://bb.example.com",
      cleanupGraceMinutes: 60,
    });
  });

  it("fails through the Effect error channel for unknown and invalid environments", async () => {
    await expect(Effect.runPromise(synthesize(setup, { environment: "missing" }))).rejects.toMatchObject({
      code: "environment_not_found",
    });
    const invalid = defineSetup({
      default: "bad",
      environments: { bad: environment({ compute: compute.exe({ template: "x", resources: { cpu: 0 } }), repository: app }) },
    });
    await expect(Effect.runPromise(synthesize(invalid))).rejects.toMatchObject({ code: "invalid_project_config" });
  });

  it("renders deterministic JSON artifacts", async () => {
    const rendered = await Effect.runPromise(synthesizeJson(setup, { environment: "review" }));
    expect(rendered.endsWith("\n")).toBe(true);
    expect(JSON.parse(rendered)).toMatchObject({ provider: "amika", templateVm: "app-snapshot" });
  });
});
