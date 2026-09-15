import { Effect, Schema } from "effect";
import {
  CONFIG_SCHEMA_URL,
  ConsumerProjectConfig,
  consumerConfigToInput,
  type ConsumerProjectConfig as ConsumerProjectConfigType,
} from "./config-file.js";
import { bbRemoteWorkspacesError, type BbRemoteWorkspacesError } from "./errors.js";
import { normalizeProjectConfig, type ProjectConfigInput } from "./types.js";

export interface ExeResources {
  readonly cpu?: number;
  readonly memory?: string;
  readonly disk?: string;
  readonly pool?: string;
}

export interface ExeCompute {
  readonly _tag: "Compute";
  readonly provider: "exe";
  readonly template: string;
  readonly resources?: ExeResources;
}

export interface AmikaCompute {
  readonly _tag: "Compute";
  readonly provider: "amika";
  readonly template: string;
}

export type Compute = ExeCompute | AmikaCompute;

export interface Repository {
  readonly _tag: "Repository";
  readonly path: string;
  readonly remote: string;
  readonly base: string;
}

export type Server =
  | { readonly _tag: "Server"; readonly mode: "connect" }
  | { readonly _tag: "Server"; readonly mode: "direct"; readonly url: string };

export interface Cleanup {
  readonly _tag: "Cleanup";
  readonly graceMinutes: number;
}

export interface DevEnvironment {
  readonly _tag: "DevEnvironment";
  readonly compute: Compute;
  readonly repository: Repository;
  readonly server: Server;
  readonly cleanup: Cleanup;
}

export interface Setup<Environments extends Readonly<Record<string, DevEnvironment>> = Readonly<Record<string, DevEnvironment>>> {
  readonly _tag: "Setup";
  readonly default: keyof Environments & string;
  readonly environments: Environments;
}

type AnySetup = {
  readonly _tag: "Setup";
  readonly default: string;
  readonly environments: Readonly<Record<string, DevEnvironment>>;
};

export const compute = {
  exe: (input: { readonly template: string; readonly resources?: ExeResources }): ExeCompute => ({
    _tag: "Compute",
    provider: "exe",
    template: input.template,
    ...(input.resources === undefined ? {} : { resources: { ...input.resources } }),
  }),
  amika: (input: { readonly template: string }): AmikaCompute => ({
    _tag: "Compute",
    provider: "amika",
    template: input.template,
  }),
} as const;

export function repository(input: { readonly path: string; readonly remote?: string; readonly base?: string }): Repository {
  return { _tag: "Repository", path: input.path, remote: input.remote ?? "origin", base: input.base ?? "main" };
}

export const server = {
  connect: (): Server => ({ _tag: "Server", mode: "connect" }),
  direct: (url: string): Server => ({ _tag: "Server", mode: "direct", url }),
} as const;

export function cleanup(input: { readonly graceMinutes?: number } = {}): Cleanup {
  return { _tag: "Cleanup", graceMinutes: input.graceMinutes ?? 30 };
}

export function environment(input: {
  readonly compute: Compute;
  readonly repository: Repository;
  readonly server?: Server;
  readonly cleanup?: Cleanup;
}): DevEnvironment {
  return {
    _tag: "DevEnvironment",
    compute: input.compute,
    repository: input.repository,
    server: input.server ?? server.connect(),
    cleanup: input.cleanup ?? cleanup(),
  };
}

export function defineSetup<const Environments extends Readonly<Record<string, DevEnvironment>>>(input: {
  readonly default: keyof Environments & string;
  readonly environments: Environments;
}): Setup<Environments> {
  return { _tag: "Setup", default: input.default, environments: input.environments };
}

export interface SynthesizeOptions {
  readonly environment?: string;
}

function selectEnvironment(
  setup: AnySetup,
  name: string,
): Effect.Effect<DevEnvironment, BbRemoteWorkspacesError> {
  const selected = setup.environments[name];
  return selected === undefined
    ? Effect.fail(bbRemoteWorkspacesError(
      "environment_not_found",
      `Environment ${name} is not defined. Available environments: ${Object.keys(setup.environments).sort().join(", ") || "none"}.`,
    ))
    : Effect.succeed(selected);
}

function renderEnvironment(value: DevEnvironment): ConsumerProjectConfigType {
  const resources = value.compute.provider === "exe" ? value.compute.resources : undefined;
  return {
    "$schema": CONFIG_SCHEMA_URL,
    version: 1,
    provider: value.compute.provider,
    templateVm: value.compute.template,
    repoPath: value.repository.path,
    remoteName: value.repository.remote,
    baseBranch: value.repository.base,
    server: value.server.mode === "direct"
      ? { mode: "direct", url: value.server.url }
      : { mode: "connect" },
    ...(resources === undefined || Object.keys(resources).length === 0 ? {} : { resources }),
    cleanup: { graceMinutes: value.cleanup.graceMinutes },
  };
}

/** Compile one named environment into the stable JSON configuration consumed by the bb plugin. */
export function synthesize(
  setup: AnySetup,
  options: SynthesizeOptions = {},
): Effect.Effect<ConsumerProjectConfigType, BbRemoteWorkspacesError> {
  const name = options.environment ?? setup.default;
  return Effect.gen(function*() {
    if (Object.keys(setup.environments).length === 0) {
      return yield* bbRemoteWorkspacesError("empty_setup", "A setup must define at least one environment.");
    }
    const selected = yield* selectEnvironment(setup, name);
    const rendered = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(ConsumerProjectConfig, { onExcessProperty: "error" })(renderEnvironment(selected)),
      catch: (error) => bbRemoteWorkspacesError(
        "invalid_environment",
        `Environment ${name}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    });
    // Reuse domain validation so DSL and JSON configurations have identical provider constraints and defaults.
    yield* normalizeProjectConfig(consumerConfigToInput("dsl", rendered));
    return rendered;
  });
}

/** Compile directly to the input accepted by Orchestrator.configureProject. */
export function projectConfigInput(
  setup: AnySetup,
  projectId: string,
  options: SynthesizeOptions = {},
): Effect.Effect<ProjectConfigInput, BbRemoteWorkspacesError> {
  return synthesize(setup, options).pipe(Effect.map((config) => consumerConfigToInput(projectId, config)));
}

/** Deterministic, newline-terminated output suitable for a checked-in config artifact. */
export function synthesizeJson(
  setup: AnySetup,
  options: SynthesizeOptions = {},
): Effect.Effect<string, BbRemoteWorkspacesError> {
  return synthesize(setup, options).pipe(Effect.map((config) => `${JSON.stringify(config, null, 2)}\n`));
}
