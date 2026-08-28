import { Effect, Schema } from "effect";
import { bbExeError, type BbExeError } from "./errors.js";

export const ServerMode = Schema.Union([Schema.Literal("connect"), Schema.Literal("direct")]);
export type ServerMode = typeof ServerMode.Type;

export const ProjectConfigInput = Schema.Struct({
  projectId: Schema.String, templateVm: Schema.String, repoPath: Schema.String,
  remoteName: Schema.optionalKey(Schema.String), baseBranch: Schema.optionalKey(Schema.String),
  serverMode: Schema.optionalKey(ServerMode), directServerUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
  cpu: Schema.optionalKey(Schema.NullOr(Schema.Number)), memory: Schema.optionalKey(Schema.NullOr(Schema.String)),
  disk: Schema.optionalKey(Schema.NullOr(Schema.String)), pool: Schema.optionalKey(Schema.NullOr(Schema.String)),
  cleanupGraceMinutes: Schema.optionalKey(Schema.Number),
});
export type ProjectConfigInput = typeof ProjectConfigInput.Type;

export const ProjectConfig = Schema.Struct({
  projectId: Schema.String, templateVm: Schema.String, repoPath: Schema.String,
  remoteName: Schema.String, baseBranch: Schema.String, serverMode: ServerMode,
  directServerUrl: Schema.NullOr(Schema.String), cpu: Schema.NullOr(Schema.Number),
  memory: Schema.NullOr(Schema.String), disk: Schema.NullOr(Schema.String), pool: Schema.NullOr(Schema.String),
  cleanupGraceMinutes: Schema.Number, createdAt: Schema.Number, updatedAt: Schema.Number,
});
export type ProjectConfig = typeof ProjectConfig.Type;

export const WorkspaceState = Schema.Union([
  Schema.Literal("requested"), Schema.Literal("cloning"), Schema.Literal("marking"),
  Schema.Literal("preparing_repo"), Schema.Literal("enrolling"), Schema.Literal("connecting"),
  Schema.Literal("spawning"), Schema.Literal("ready"), Schema.Literal("cleanup_scheduled"),
  Schema.Literal("retained"), Schema.Literal("deleting"), Schema.Literal("error"), Schema.Literal("deleted"),
]);
export type WorkspaceState = typeof WorkspaceState.Type;
export const DesiredWorkspaceState = Schema.Union([Schema.Literal("ready"), Schema.Literal("retained"), Schema.Literal("deleted")]);
export type DesiredWorkspaceState = typeof DesiredWorkspaceState.Type;

export const WorkspaceRecord = Schema.Struct({
  id: Schema.String, projectId: Schema.String, state: WorkspaceState, desiredState: DesiredWorkspaceState,
  vmName: Schema.String, hostId: Schema.NullOr(Schema.String), environmentId: Schema.NullOr(Schema.String),
  rootThreadId: Schema.NullOr(Schema.String), baseRef: Schema.String, baseSha: Schema.NullOr(Schema.String),
  branchName: Schema.String, cleanupAfter: Schema.NullOr(Schema.Number), retentionReason: Schema.NullOr(Schema.String),
  lastErrorCode: Schema.NullOr(Schema.String), lastErrorMessage: Schema.NullOr(Schema.String),
  createdAt: Schema.Number, updatedAt: Schema.Number, readyAt: Schema.NullOr(Schema.Number), deletedAt: Schema.NullOr(Schema.Number),
});
export type WorkspaceRecord = typeof WorkspaceRecord.Type;

export const CreateWorkspaceInput = Schema.Struct({
  projectId: Schema.String, prompt: Schema.String, title: Schema.optionalKey(Schema.String),
  providerId: Schema.optionalKey(Schema.String), model: Schema.optionalKey(Schema.String),
});
export type CreateWorkspaceInput = typeof CreateWorkspaceInput.Type;
export const DestroyWorkspaceInput = Schema.Struct({ workspaceId: Schema.String, force: Schema.optionalKey(Schema.Boolean) });
export type DestroyWorkspaceInput = typeof DestroyWorkspaceInput.Type;

export const RemotePrepareResult = Schema.Struct({
  clean: Schema.Boolean, baseSha: Schema.String, branch: Schema.String, copiedBbIdentityCount: Schema.Number,
});
export type RemotePrepareResult = typeof RemotePrepareResult.Type;
export const RemoteInspection = Schema.Struct({
  clean: Schema.Boolean, ahead: Schema.Number, markerMatches: Schema.Boolean, branch: Schema.String, headSha: Schema.String,
});
export type RemoteInspection = typeof RemoteInspection.Type;

export interface DoctorResult {
  readonly ok: boolean; readonly projectId: string; readonly templateVm: string; readonly templateStatus: string;
  readonly baseSha: string; readonly copiedBbIdentityCount: number;
  readonly checks: ReadonlyArray<{ readonly name: string; readonly ok: boolean; readonly message: string }>;
}

export function decodeUnknown<S extends Schema.Constraint & { readonly DecodingServices: never }>(schema: S, value: unknown, label: string): Effect.Effect<S["Type"], BbExeError> {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(value),
    catch: (error) => bbExeError("invalid_input", `${label}: ${error instanceof Error ? error.message : String(error)}`),
  });
}

export function normalizeProjectConfig(input: ProjectConfigInput, previous?: ProjectConfig, now = Date.now()): Effect.Effect<ProjectConfig, BbExeError> {
  return Effect.gen(function*() {
    if ([input.projectId, input.templateVm, input.repoPath].some((value) => value.trim() === ""))
      return yield* bbExeError("invalid_project_config", "Project id, template VM, and repo path are required.");
    if (!input.repoPath.startsWith("/")) return yield* bbExeError("invalid_project_config", "repoPath must be absolute.");
    const mode = input.serverMode ?? "connect";
    const directServerUrl = input.directServerUrl ?? null;
    if (mode === "direct" && directServerUrl === null) return yield* bbExeError("invalid_project_config", "directServerUrl is required in direct mode.");
    if (directServerUrl !== null) {
      let parsed: URL;
      try { parsed = new URL(directServerUrl); } catch { return yield* bbExeError("invalid_project_config", "directServerUrl must be a valid HTTPS URL."); }
      if (parsed.protocol !== "https:") return yield* bbExeError("invalid_project_config", "directServerUrl must use HTTPS.");
    }
    const cleanupGraceMinutes = input.cleanupGraceMinutes ?? 30;
    if (!Number.isInteger(cleanupGraceMinutes) || cleanupGraceMinutes < 5 || cleanupGraceMinutes > 10_080)
      return yield* bbExeError("invalid_project_config", "cleanupGraceMinutes must be an integer from 5 to 10080.");
    const cpu = input.cpu ?? null;
    if (cpu !== null && (!Number.isInteger(cpu) || cpu < 1 || cpu > 128))
      return yield* bbExeError("invalid_project_config", "cpu must be an integer from 1 to 128.");
    return {
      projectId: input.projectId.trim(), templateVm: input.templateVm.trim(), repoPath: input.repoPath.trim(),
      remoteName: input.remoteName?.trim() || "origin", baseBranch: input.baseBranch?.trim() || "main",
      serverMode: mode, directServerUrl, cpu, memory: input.memory?.trim() || null, disk: input.disk?.trim() || null,
      pool: input.pool?.trim() || null, cleanupGraceMinutes, createdAt: previous?.createdAt ?? now, updatedAt: now,
    } satisfies ProjectConfig;
  });
}
