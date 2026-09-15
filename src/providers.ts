import { Context, Effect, type Schema } from "effect";
import type { BbRemoteWorkspacesError } from "./errors.js";
import type { ProjectConfig, WorkspaceProviderId, WorkspaceRecord } from "./types.js";

export interface ProviderMachine {
  readonly name: string;
  readonly status: string;
  readonly tags: ReadonlyArray<string>;
  readonly comment: string | null;
  readonly raw: unknown;
}
export interface WorkspaceProvider {
  readonly whoami: Effect.Effect<unknown, BbRemoteWorkspacesError>;
  readonly listVms: Effect.Effect<ReadonlyArray<ProviderMachine>, BbRemoteWorkspacesError>;
  readonly copyVm: (source: string, destination: string, config: ProjectConfig) => Effect.Effect<string | void, BbRemoteWorkspacesError>;
  readonly markVm: (name: string, workspaceId: string, projectId: string) => Effect.Effect<void, BbRemoteWorkspacesError>;
  readonly ownsVm: (machine: ProviderMachine, record: WorkspaceRecord) => boolean;
  readonly removeVm: (name: string, resourceId?: string) => Effect.Effect<void, BbRemoteWorkspacesError>;
  readonly runCommand: (name: string, command: string) => Effect.Effect<unknown, BbRemoteWorkspacesError>;
  readonly runScript: <S extends Schema.Constraint & { readonly DecodingServices: never }>(name: string, script: string, args: ReadonlyArray<string>, output: S) => Effect.Effect<S["Type"], BbRemoteWorkspacesError>;
  readonly inspectSnapshot?: (name: string) => Effect.Effect<{ readonly state: string }, BbRemoteWorkspacesError>;
}
export class WorkspaceProviders extends Context.Service<WorkspaceProviders, Readonly<Record<WorkspaceProviderId, WorkspaceProvider>>>()("bb-remote-workspaces/WorkspaceProviders") {}
