import type { BbPluginApi, PluginSettingsHandle } from "@get-bb/plugin-sdk";
import { Context, Effect, Layer, Schema } from "effect";
import { z } from "zod";
import { asBbRemoteWorkspacesError, type BbRemoteWorkspacesError } from "./errors.js";
import type { CreateWorkspaceInput } from "./types.js";

export const settingsDescriptors = {
  amikaToken: { type: "string", label: "Amika API token", description: "Amika Cloud API key. Requires the Amika CLI and SSH identity on the plugin server.", secret: true },
  exeToken: { type: "string", label: "exe.dev API token", description: "Token from exe.dev/settings. Stored as a bb secret.", secret: true },
} as const;
export type BbRemoteWorkspacesSettings = PluginSettingsHandle<typeof settingsDescriptors>;

export const Enrollment = Schema.Struct({ hostId: Schema.String, joinCode: Schema.String, serverUrl: Schema.String, machineCode: Schema.NullOr(Schema.String) });
export type Enrollment = typeof Enrollment.Type;
export interface SpawnedThread { readonly id: string; readonly environmentId: string }

export interface BbPlatformShape {
  readonly enrollHost: (mode: "connect" | "direct", directServerUrl: string | null) => Effect.Effect<Enrollment, BbRemoteWorkspacesError>;
  readonly waitForHost: (hostId: string, name: string) => Effect.Effect<void, BbRemoteWorkspacesError>;
  readonly spawnThread: (hostId: string, repoPath: string, input: CreateWorkspaceInput) => Effect.Effect<SpawnedThread, BbRemoteWorkspacesError>;
  readonly getThread: (threadId: string) => Effect.Effect<{ readonly archived: boolean }, BbRemoteWorkspacesError>;
  readonly inspectEnvironment: (environmentId: string) => Effect.Effect<{ readonly safe: boolean; readonly openThreadIds: ReadonlyArray<string>; readonly activeTerminalIds: ReadonlyArray<string> }, BbRemoteWorkspacesError>;
  readonly archiveEnvironment: (environmentId: string) => Effect.Effect<void, BbRemoteWorkspacesError>;
  readonly deleteHost: (hostId: string) => Effect.Effect<void, BbRemoteWorkspacesError>;
  readonly readTextFile: (path: string) => Effect.Effect<string, BbRemoteWorkspacesError>;
  readonly logInfo: (message: string) => Effect.Effect<void>;
  readonly logError: (message: string) => Effect.Effect<void>;
}
export class BbPlatform extends Context.Service<BbPlatform, BbPlatformShape>()("bb-remote-workspaces/BbPlatform") {}

function promise<A>(code: string, thunk: (signal: AbortSignal) => Promise<A>): Effect.Effect<A, BbRemoteWorkspacesError> {
  return Effect.tryPromise({ try: thunk, catch: (error) => asBbRemoteWorkspacesError(error, code) });
}

export function makeBbPlatformLayer(bb: BbPluginApi, settings: BbRemoteWorkspacesSettings): Layer.Layer<BbPlatform> {
  return Layer.succeed(BbPlatform, {
    enrollHost: (mode, directServerUrl) => Effect.gen(function*() {
      const issued = yield* promise("host_enrollment_failed", () => bb.sdk.hosts.createJoinCode());
      if (mode === "direct") return { hostId: issued.hostId, joinCode: issued.joinCode, serverUrl: directServerUrl!, machineCode: null };
      const machine = yield* promise("connect_machine_code_failed", () => bb.sdk.plugins.callRpc({
        pluginId: "connect", method: "createMachineCode", input: null,
        outputSchema: z.object({ code: z.string(), serverUrl: z.string(), expiresAt: z.number() }),
      }));
      return { hostId: issued.hostId, joinCode: issued.joinCode, serverUrl: machine.serverUrl, machineCode: machine.code };
    }),
    waitForHost: (hostId, name) => Effect.gen(function*() {
      for (let attempt = 0; attempt < 60; attempt++) {
        const host = yield* promise("host_status_failed", (signal) => bb.sdk.hosts.get({ hostId, signal }));
        if (host.status === "connected") { yield* promise("host_rename_failed", () => bb.sdk.hosts.update({ hostId, name })); return; }
        yield* Effect.sleep("2 seconds");
      }
      return yield* asBbRemoteWorkspacesError(new Error(`Host ${hostId} did not connect within two minutes.`), "host_connect_timeout");
    }),
    spawnThread: (hostId, repoPath, input) => promise("thread_spawn_failed", () => bb.sdk.threads.spawn({
      projectId: input.projectId, prompt: input.prompt, ...(input.title ? { title: input.title } : {}),
      ...(input.providerId ? { providerId: input.providerId } : {}), ...(input.model ? { model: input.model } : {}),
      environment: { type: "host", hostId, workspace: { type: "unmanaged", path: repoPath } },
    })).pipe(Effect.flatMap((thread) => thread.environmentId === null
      ? Effect.fail(asBbRemoteWorkspacesError(new Error("Spawned thread has no environment."), "thread_environment_missing"))
      : Effect.succeed({ id: thread.id, environmentId: thread.environmentId }))),
    getThread: (threadId) => promise("thread_status_failed", (signal) => bb.sdk.threads.get({ threadId, signal })).pipe(Effect.map((thread) => ({ archived: thread.archivedAt !== null }))),
    inspectEnvironment: (environmentId) => Effect.all({
      threads: promise("thread_list_failed", (signal) => bb.sdk.threads.list({ archived: false, signal })),
      terminals: promise("terminal_list_failed", (signal) => bb.sdk.terminals.list({ scope: { kind: "environment", environmentId }, signal })),
    }).pipe(Effect.map(({ threads, terminals }) => {
      const openThreadIds = threads.filter((thread) => thread.environmentId === environmentId).map((thread) => thread.id);
      const activeTerminalIds = terminals.sessions.filter((terminal) => terminal.status === "running" || terminal.status === "starting").map((terminal) => terminal.id);
      return { safe: openThreadIds.length === 0 && activeTerminalIds.length === 0, openThreadIds, activeTerminalIds };
    })),
    archiveEnvironment: (environmentId) => promise("environment_archive_failed", () => bb.sdk.environments.archiveThreads({ environmentId })).pipe(Effect.asVoid),
    deleteHost: (hostId) => promise("host_delete_failed", () => bb.sdk.hosts.delete({ hostId })).pipe(Effect.asVoid),
    readTextFile: (path) => promise("config_file_read_failed", (signal) => bb.sdk.files.read({ path, signal })).pipe(
      Effect.flatMap((file) => file.contentEncoding === "utf8"
        ? Effect.succeed(file.content)
        : Effect.try({ try: () => Buffer.from(file.content, "base64").toString("utf8"), catch: (error) => asBbRemoteWorkspacesError(error, "config_file_decode_failed") })),
    ),
    logInfo: (message) => Effect.sync(() => bb.log.info(message)),
    logError: (message) => Effect.sync(() => bb.log.error(message)),
  });
}
