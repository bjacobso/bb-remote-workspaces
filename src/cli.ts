import type { PluginCliContext, PluginCliResult } from "@get-bb/plugin-sdk";
import { Effect, Schema } from "effect";
import { isAbsolute, resolve } from "node:path";
import { errorMessage } from "./errors.js";
import type { OrchestratorShape } from "./orchestrator.js";
import type { BbExtensionRuntime } from "./runtime.js";
import { WorkspaceProviderId, type ProjectConfigInput } from "./types.js";

function value(argv: ReadonlyArray<string>, flag: string): string | undefined {
  const index = argv.indexOf(flag); return index < 0 ? undefined : argv[index + 1];
}
function required(argv: ReadonlyArray<string>, flag: string): string {
  const found = value(argv, flag); if (!found) throw new Error(`${flag} is required.`); return found;
}
const json = (data: unknown): PluginCliResult => ({ exitCode: 0, stdout: `${JSON.stringify(data, null, 2)}\n` });

function configPath(argv: ReadonlyArray<string>, ctx: PluginCliContext): string {
  const path = required(argv, "--file");
  return isAbsolute(path) ? path : resolve(ctx.cwd ?? process.cwd(), path);
}

function applyConfigOverrides(base: ProjectConfigInput, argv: ReadonlyArray<string>): ProjectConfigInput {
  const serverUrl = value(argv, "--server-url");
  return {
    ...base,
    ...(value(argv, "--provider") === undefined ? {} : { provider: Schema.decodeUnknownSync(WorkspaceProviderId)(value(argv, "--provider")) }),
    ...(value(argv, "--template") ? { templateVm: value(argv, "--template")! } : {}),
    ...(value(argv, "--repo-path") ? { repoPath: value(argv, "--repo-path")! } : {}),
    ...(value(argv, "--remote") ? { remoteName: value(argv, "--remote")! } : {}),
    ...(value(argv, "--base") ? { baseBranch: value(argv, "--base")! } : {}),
    ...(serverUrl ? { serverMode: "direct" as const, directServerUrl: serverUrl } : {}),
    ...(value(argv, "--cpu") ? { cpu: Number(value(argv, "--cpu")) } : {}),
    ...(value(argv, "--memory") ? { memory: value(argv, "--memory")! } : {}),
    ...(value(argv, "--disk") ? { disk: value(argv, "--disk")! } : {}),
    ...(value(argv, "--pool") ? { pool: value(argv, "--pool")! } : {}),
    ...(value(argv, "--grace") ? { cleanupGraceMinutes: Number(value(argv, "--grace")) } : {}),
  };
}

export async function runCli(runtime: BbExtensionRuntime, argv: string[], ctx: PluginCliContext): Promise<PluginCliResult> {
  try {
    const [command] = argv;
    const invoke = <A>(f: (service: OrchestratorShape) => Effect.Effect<A, unknown>) => runtime.use(f, ctx.signal);
    switch (command) {
      case "project": {
        const action = argv[1]; const args = argv.slice(2); const projectId = value(args, "--project") ?? ctx.projectId;
        if (!projectId) throw new Error("--project is required outside a project context.");
        if (action === "show") return json(await invoke((o) => o.getProject(projectId)));
        if (action === "doctor") return json(await invoke((o) => o.doctor(projectId)));
        if (action === "diff") return json(await invoke((o) => o.diffProjectConfigFile(projectId, configPath(args, ctx))));
        if (action === "configure") return json(await invoke((o) => Effect.gen(function*() {
          const base = value(args, "--file")
            ? yield* o.loadProjectConfigFile(projectId, configPath(args, ctx))
            : { projectId, templateVm: required(args, "--template"), repoPath: required(args, "--repo-path") };
          return yield* o.configureProject(applyConfigOverrides(base, args));
        })));
        break;
      }
      case "create": {
        const projectId = value(argv, "--project") ?? ctx.projectId; if (!projectId) throw new Error("--project is required.");
        return json(await invoke((o) => o.create({ projectId, prompt: required(argv, "--prompt"), ...(value(argv, "--title") ? { title: value(argv, "--title")! } : {}) })));
      }
      case "list": return json(await invoke((o) => o.list(value(argv, "--project") ?? ctx.projectId)));
      case "show": return json(await invoke((o) => o.get(required(argv, "--id"))));
      case "retain": return json(await invoke((o) => o.retain(required(argv, "--id"), value(argv, "--reason") ?? "retained from CLI")));
      case "destroy": {
        if (!argv.includes("--yes")) throw new Error("destroy requires --yes.");
        return json(await invoke((o) => o.destroy({ workspaceId: required(argv, "--id"), ...(argv.includes("--force") ? { force: true } : {}) })));
      }
      case "gc": await invoke((o) => o.reconcile); return json({ ok: true });
    }
    return { exitCode: 2, stderr: "Usage: bb remote-workspaces <project|create|list|show|retain|destroy|gc> [options]\n" };
  } catch (error) {
    return { exitCode: 1, stderr: `${errorMessage(error)}\n` };
  }
}
