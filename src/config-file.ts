import { Effect, Schema } from "effect";
import { bbRemoteWorkspacesError, type BbRemoteWorkspacesError } from "./errors.js";
import { WorkspaceProviderId, type ProjectConfig, type ProjectConfigInput } from "./types.js";

export const CONFIG_SCHEMA_URL = "https://raw.githubusercontent.com/bjacobso/bb-remote-workspaces/main/schema.json";

const ConsumerServerConfig = Schema.Struct({
  mode: Schema.Union([Schema.Literal("connect"), Schema.Literal("direct")]),
  url: Schema.optionalKey(Schema.String),
});
const ConsumerResourcesConfig = Schema.Struct({
  cpu: Schema.optionalKey(Schema.Number),
  memory: Schema.optionalKey(Schema.String),
  disk: Schema.optionalKey(Schema.String),
  pool: Schema.optionalKey(Schema.String),
});
const ConsumerCleanupConfig = Schema.Struct({
  graceMinutes: Schema.optionalKey(Schema.Number),
});

export const ConsumerProjectConfig = Schema.Struct({
  "$schema": Schema.optionalKey(Schema.String),
  version: Schema.Literal(1),
  provider: Schema.optionalKey(WorkspaceProviderId),
  templateVm: Schema.String,
  repoPath: Schema.String,
  remoteName: Schema.optionalKey(Schema.String),
  baseBranch: Schema.optionalKey(Schema.String),
  server: Schema.optionalKey(ConsumerServerConfig),
  resources: Schema.optionalKey(ConsumerResourcesConfig),
  cleanup: Schema.optionalKey(ConsumerCleanupConfig),
});
export type ConsumerProjectConfig = typeof ConsumerProjectConfig.Type;

export interface ProjectConfigChange {
  readonly path: string;
  readonly current: string | number | null;
  readonly desired: string | number | null;
}
export interface ProjectConfigDiff {
  readonly projectId: string;
  readonly filePath: string;
  readonly configured: boolean;
  readonly changed: boolean;
  readonly changes: ReadonlyArray<ProjectConfigChange>;
}

export function parseConsumerProjectConfig(content: string, filePath: string): Effect.Effect<ConsumerProjectConfig, BbRemoteWorkspacesError> {
  return Effect.gen(function*() {
    const json = yield* Effect.try({
      try: () => JSON.parse(content) as unknown,
      catch: (error) => bbRemoteWorkspacesError("invalid_config_json", `${filePath}: ${error instanceof Error ? error.message : String(error)}`),
    });
    return yield* Effect.try({
      try: () => Schema.decodeUnknownSync(ConsumerProjectConfig, { onExcessProperty: "error" })(json),
      catch: (error) => bbRemoteWorkspacesError("invalid_config_file", `${filePath}: ${error instanceof Error ? error.message : String(error)}`),
    });
  });
}

export function consumerConfigToInput(projectId: string, config: ConsumerProjectConfig): ProjectConfigInput {
  return {
    projectId,
    ...(config.provider === undefined ? {} : { provider: config.provider }),
    templateVm: config.templateVm,
    repoPath: config.repoPath,
    ...(config.remoteName === undefined ? {} : { remoteName: config.remoteName }),
    ...(config.baseBranch === undefined ? {} : { baseBranch: config.baseBranch }),
    ...(config.server === undefined ? {} : {
      serverMode: config.server.mode,
      directServerUrl: config.server.url ?? null,
    }),
    ...(config.resources?.cpu === undefined ? {} : { cpu: config.resources.cpu }),
    ...(config.resources?.memory === undefined ? {} : { memory: config.resources.memory }),
    ...(config.resources?.disk === undefined ? {} : { disk: config.resources.disk }),
    ...(config.resources?.pool === undefined ? {} : { pool: config.resources.pool }),
    ...(config.cleanup?.graceMinutes === undefined ? {} : { cleanupGraceMinutes: config.cleanup.graceMinutes }),
  };
}

const comparableFields = [
  "provider", "templateVm", "repoPath", "remoteName", "baseBranch", "serverMode", "directServerUrl",
  "cpu", "memory", "disk", "pool", "cleanupGraceMinutes",
] as const satisfies ReadonlyArray<keyof ProjectConfig>;

export function diffProjectConfig(projectId: string, filePath: string, current: ProjectConfig | undefined, desired: ProjectConfig): ProjectConfigDiff {
  const changes = comparableFields.flatMap((field) => {
    const before = current?.[field] ?? null;
    const after = desired[field] ?? null;
    return before === after ? [] : [{ path: field, current: before, desired: after } satisfies ProjectConfigChange];
  });
  return { projectId, filePath, configured: current !== undefined, changed: changes.length > 0, changes };
}
