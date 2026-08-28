import type { BbPluginApi, PluginAgentToolContext } from "@get-bb/plugin-sdk";
import { Effect, Schema } from "effect";
import { runCli } from "./src/cli.js";
import { errorMessage } from "./src/errors.js";
import { Orchestrator } from "./src/orchestrator.js";
import { BbExtensionRuntime } from "./src/runtime.js";
import { settingsDescriptors } from "./src/bb-platform.js";
import { CreateWorkspaceInput, decodeUnknown, DestroyWorkspaceInput } from "./src/types.js";

const WorkspaceIdInput = Schema.Struct({ workspaceId: Schema.String });
const RetainInput = Schema.Struct({ workspaceId: Schema.String, reason: Schema.optionalKey(Schema.String) });
const ProjectInput = Schema.Struct({ projectId: Schema.String });
const ListInput = Schema.Struct({ projectId: Schema.optionalKey(Schema.String) });

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const string = { type: "string" };

export default function plugin(bb: BbPluginApi): void {
  const settings = bb.settings.define(settingsDescriptors);
  const runtime = new BbExtensionRuntime(bb, settings);
  bb.onDispose(() => runtime.dispose());

  bb.cli.register({
    name: "exe", summary: "Manage disposable exe.dev workspaces.",
    commands: [
      { name: "project", summary: "Configure or diagnose a project.", usage: "bb exe project <configure|show|doctor>" },
      { name: "create", summary: "Clone a VM and spawn a bb thread.", usage: "bb exe create --prompt <text>" },
      { name: "list", summary: "List managed workspaces.", usage: "bb exe list [--project <id>]" },
      { name: "show", summary: "Inspect a workspace.", usage: "bb exe show --id <id>" },
      { name: "retain", summary: "Prevent automatic deletion.", usage: "bb exe retain --id <id> [--reason <text>]" },
      { name: "destroy", summary: "Safely destroy a workspace.", usage: "bb exe destroy --id <id> --yes [--force]" },
      { name: "gc", summary: "Run cleanup reconciliation now.", usage: "bb exe gc" },
    ],
    run: (argv, ctx) => runCli(runtime, argv, ctx),
  });

  const tool = <S extends Schema.Constraint & { readonly DecodingServices: never }, A>(
    name: string, description: string, parameters: Record<string, unknown>, schema: S,
    execute: (params: S["Type"], ctx: PluginAgentToolContext) => Effect.Effect<A, unknown, Orchestrator>,
  ) => bb.agents.registerTool({
    name, description, parameters,
    execute: async (params, ctx) => {
      try {
        const program = decodeUnknown(schema, params, `${name} parameters`).pipe(Effect.flatMap((decoded) => execute(decoded, ctx)));
        return JSON.stringify(await runtime.run(program, ctx.signal), null, 2);
      } catch (error) { return { content: [{ type: "text", text: errorMessage(error) }], isError: true }; }
    },
  });

  tool("exe_create_workspace", "Create an isolated exe.dev VM clone, enroll it in bb, and start a root thread.", objectSchema({ projectId: string, prompt: string, title: string }, ["projectId", "prompt"]), CreateWorkspaceInput, (input) => Effect.flatMap(Orchestrator, (o) => o.create(input)));
  tool("exe_get_workspace", "Get lifecycle and ownership state for one exe.dev workspace.", objectSchema({ workspaceId: string }, ["workspaceId"]), WorkspaceIdInput, (input) => Effect.flatMap(Orchestrator, (o) => o.get(input.workspaceId)));
  tool("exe_list_workspaces", "List exe.dev workspaces, optionally for a bb project.", objectSchema({ projectId: string }), ListInput, (input) => Effect.flatMap(Orchestrator, (o) => o.list(input.projectId)));
  tool("exe_retain_workspace", "Retain a workspace so automatic cleanup cannot delete it.", objectSchema({ workspaceId: string, reason: string }, ["workspaceId"]), RetainInput, (input) => Effect.flatMap(Orchestrator, (o) => o.retain(input.workspaceId, input.reason ?? "retained by agent")));
  tool("exe_destroy_workspace", "Safely destroy a workspace only when its marker matches, git is clean, and its root thread is archived. This tool cannot force deletion.", objectSchema({ workspaceId: string }, ["workspaceId"]), DestroyWorkspaceInput, (input) => Effect.flatMap(Orchestrator, (o) => o.destroy({ workspaceId: input.workspaceId })));
  tool("exe_doctor", "Validate exe.dev credentials and a project's template VM without creating resources.", objectSchema({ projectId: string }, ["projectId"]), ProjectInput, (input) => Effect.flatMap(Orchestrator, (o) => o.doctor(input.projectId)));

  bb.agents.configure(() => ({
    tools: ["exe_create_workspace", "exe_get_workspace", "exe_list_workspaces", "exe_retain_workspace", "exe_destroy_workspace", "exe_doctor"],
    skills: ["exe-workspaces"],
  }));

  const schedule = ({ thread }: { thread: { id: string } }) => runtime.use((o) => o.scheduleCleanupForThread(thread.id)).catch((error) => bb.log.error(errorMessage(error)));
  bb.events.on("thread.archived", schedule);
  bb.events.on("thread.deleted", schedule);

  bb.background.service("workspace-reconciler", {
    start: (signal) => runtime.run(Effect.flatMap(Orchestrator, (o) => Effect.forever(o.reconcile.pipe(Effect.andThen(Effect.sleep("60 seconds"))))), signal),
  });
}
