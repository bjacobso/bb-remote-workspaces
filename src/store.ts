import type Database from "better-sqlite3";
import { Context, Effect, Layer } from "effect";
import { asBbRemoteWorkspacesError, bbRemoteWorkspacesError, type BbRemoteWorkspacesError } from "./errors.js";
import { decodeUnknown, ProjectConfig, WorkspaceRecord, type WorkspaceState, type DesiredWorkspaceState } from "./types.js";

const MIGRATIONS = [
  `CREATE TABLE project_configs (
    project_id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE workspaces (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, state TEXT NOT NULL,
    desired_state TEXT NOT NULL, payload TEXT NOT NULL, cleanup_after INTEGER,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX workspaces_project_idx ON workspaces(project_id, updated_at DESC)`,
  `CREATE INDEX workspaces_cleanup_idx ON workspaces(desired_state, cleanup_after)`,
] as const;

export interface WorkspacePatch {
  readonly providerResourceId?: string;
  readonly state?: WorkspaceState; readonly desiredState?: DesiredWorkspaceState;
  readonly hostId?: string | null; readonly environmentId?: string | null; readonly rootThreadId?: string | null;
  readonly baseSha?: string | null; readonly cleanupAfter?: number | null; readonly retentionReason?: string | null;
  readonly lastErrorCode?: string | null; readonly lastErrorMessage?: string | null;
  readonly readyAt?: number | null; readonly deletedAt?: number | null;
}
export interface WorkspaceStoreShape {
  readonly putProject: (config: ProjectConfig) => Effect.Effect<ProjectConfig, BbRemoteWorkspacesError>;
  readonly getProject: (projectId: string) => Effect.Effect<ProjectConfig, BbRemoteWorkspacesError>;
  readonly listProjects: Effect.Effect<ReadonlyArray<ProjectConfig>, BbRemoteWorkspacesError>;
  readonly insertWorkspace: (record: WorkspaceRecord) => Effect.Effect<WorkspaceRecord, BbRemoteWorkspacesError>;
  readonly getWorkspace: (id: string) => Effect.Effect<WorkspaceRecord, BbRemoteWorkspacesError>;
  readonly listWorkspaces: (projectId?: string) => Effect.Effect<ReadonlyArray<WorkspaceRecord>, BbRemoteWorkspacesError>;
  readonly updateWorkspace: (id: string, patch: WorkspacePatch) => Effect.Effect<WorkspaceRecord, BbRemoteWorkspacesError>;
}
export class WorkspaceStore extends Context.Service<WorkspaceStore, WorkspaceStoreShape>()("bb-remote-workspaces/WorkspaceStore") {}

export function makeWorkspaceStoreLayer(db: Database.Database, migrate: (db: Database.Database, statements: string[]) => void): Layer.Layer<WorkspaceStore, BbRemoteWorkspacesError> {
  return Layer.effect(WorkspaceStore, Effect.try({
    try: () => {
      migrate(db, [...MIGRATIONS]);
      const decodeProject = (payload: string) => decodeUnknown(ProjectConfig, { provider: "exe", ...JSON.parse(payload) }, "stored project config");
      const decodeWorkspace = (payload: string) => decodeUnknown(WorkspaceRecord, { provider: "exe", ...JSON.parse(payload) }, "stored workspace");
      const getProject = (projectId: string) => Effect.gen(function*() {
        const row = yield* Effect.try({ try: () => db.prepare("SELECT payload FROM project_configs WHERE project_id = ?").get(projectId) as { payload: string } | undefined, catch: (e) => asBbRemoteWorkspacesError(e, "store_read_failed") });
        if (!row) return yield* bbRemoteWorkspacesError("project_not_configured", `Project ${projectId} is not configured for remote workspaces.`);
        return yield* decodeProject(row.payload);
      });
      const getWorkspace = (id: string) => Effect.gen(function*() {
        const row = yield* Effect.try({ try: () => db.prepare("SELECT payload FROM workspaces WHERE id = ?").get(id) as { payload: string } | undefined, catch: (e) => asBbRemoteWorkspacesError(e, "store_read_failed") });
        if (!row) return yield* bbRemoteWorkspacesError("workspace_not_found", `Workspace ${id} was not found.`);
        return yield* decodeWorkspace(row.payload);
      });
      const saveWorkspace = (record: WorkspaceRecord) => Effect.try({
        try: () => { db.prepare(`INSERT INTO workspaces(id, project_id, state, desired_state, payload, cleanup_after, updated_at)
          VALUES (@id,@projectId,@state,@desiredState,@payload,@cleanupAfter,@updatedAt)
          ON CONFLICT(id) DO UPDATE SET state=excluded.state, desired_state=excluded.desired_state,
          payload=excluded.payload, cleanup_after=excluded.cleanup_after, updated_at=excluded.updated_at`).run({ ...record, payload: JSON.stringify(record) }); return record; },
        catch: (e) => asBbRemoteWorkspacesError(e, "store_write_failed"),
      });
      return {
        putProject: (config) => Effect.try({ try: () => { db.prepare(`INSERT INTO project_configs(project_id,payload,updated_at) VALUES (?,?,?) ON CONFLICT(project_id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at`).run(config.projectId, JSON.stringify(config), config.updatedAt); return config; }, catch: (e) => asBbRemoteWorkspacesError(e, "store_write_failed") }),
        getProject,
        listProjects: Effect.try({ try: () => db.prepare("SELECT payload FROM project_configs ORDER BY project_id").all() as Array<{ payload: string }>, catch: (e) => asBbRemoteWorkspacesError(e, "store_read_failed") }).pipe(Effect.flatMap((rows) => Effect.all(rows.map((r) => decodeProject(r.payload))))),
        insertWorkspace: saveWorkspace,
        getWorkspace,
        listWorkspaces: (projectId) => Effect.try({ try: () => projectId ? db.prepare("SELECT payload FROM workspaces WHERE project_id=? ORDER BY updated_at DESC").all(projectId) as Array<{payload:string}> : db.prepare("SELECT payload FROM workspaces ORDER BY updated_at DESC").all() as Array<{payload:string}>, catch: (e) => asBbRemoteWorkspacesError(e, "store_read_failed") }).pipe(Effect.flatMap((rows) => Effect.all(rows.map((r) => decodeWorkspace(r.payload))))),
        updateWorkspace: (id, patch) => getWorkspace(id).pipe(Effect.flatMap((current) => saveWorkspace({ ...current, ...patch, updatedAt: Date.now() }))),
      } satisfies WorkspaceStoreShape;
    },
    catch: (e) => asBbRemoteWorkspacesError(e, "store_init_failed"),
  }));
}
