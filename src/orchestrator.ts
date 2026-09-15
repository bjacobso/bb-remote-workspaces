import { Context, Effect, Layer } from "effect";
import { randomUUID } from "node:crypto";
import { BbPlatform } from "./bb-platform.js";
import { consumerConfigToInput, diffProjectConfig, parseConsumerProjectConfig, type ProjectConfigDiff } from "./config-file.js";
import { bbRemoteWorkspacesError, type BbRemoteWorkspacesError } from "./errors.js";
import { WorkspaceProviders } from "./providers.js";
import { DOCTOR_REPOSITORY_SCRIPT, INSPECT_REPOSITORY_SCRIPT, PREPARE_REPOSITORY_SCRIPT, installBbCommand } from "./remote-scripts.js";
import { WorkspaceStore } from "./store.js";
import { normalizeProjectConfig, RemoteInspection, RemotePrepareResult, type CreateWorkspaceInput, type DestroyWorkspaceInput, type DoctorResult, type ProjectConfig, type ProjectConfigInput, type WorkspaceRecord } from "./types.js";

export interface OrchestratorShape {
  readonly configureProject: (input: ProjectConfigInput) => Effect.Effect<ProjectConfig, BbRemoteWorkspacesError>;
  readonly getProject: (projectId: string) => Effect.Effect<ProjectConfig, BbRemoteWorkspacesError>;
  readonly loadProjectConfigFile: (projectId: string, filePath: string) => Effect.Effect<ProjectConfigInput, BbRemoteWorkspacesError>;
  readonly diffProjectConfigFile: (projectId: string, filePath: string) => Effect.Effect<ProjectConfigDiff, BbRemoteWorkspacesError>;
  readonly doctor: (projectId: string) => Effect.Effect<DoctorResult, BbRemoteWorkspacesError>;
  readonly create: (input: CreateWorkspaceInput) => Effect.Effect<WorkspaceRecord, BbRemoteWorkspacesError>;
  readonly get: (id: string) => Effect.Effect<WorkspaceRecord, BbRemoteWorkspacesError>;
  readonly list: (projectId?: string) => Effect.Effect<ReadonlyArray<WorkspaceRecord>, BbRemoteWorkspacesError>;
  readonly retain: (id: string, reason: string) => Effect.Effect<WorkspaceRecord, BbRemoteWorkspacesError>;
  readonly scheduleCleanupForThread: (threadId: string) => Effect.Effect<void, BbRemoteWorkspacesError>;
  readonly destroy: (input: DestroyWorkspaceInput) => Effect.Effect<WorkspaceRecord, BbRemoteWorkspacesError>;
  readonly reconcile: Effect.Effect<void, BbRemoteWorkspacesError>;
}
export class Orchestrator extends Context.Service<Orchestrator, OrchestratorShape>()("bb-remote-workspaces/Orchestrator") {}

function assertGitName(value: string, label: string): Effect.Effect<void, BbRemoteWorkspacesError> {
  return /^[A-Za-z0-9._/-]+$/.test(value) && !value.includes("..")
    ? Effect.void : Effect.fail(bbRemoteWorkspacesError("invalid_git_name", `${label} contains unsupported characters.`));
}
function vmName(projectId: string, id: string): string {
  const slug = projectId.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 28) || "project";
  return `bb-${slug}-${id.slice(0, 8)}`;
}

export const OrchestratorLive = Layer.effect(Orchestrator, Effect.gen(function*() {
  const store = yield* WorkspaceStore;
  const providers = yield* WorkspaceProviders;
  const bb = yield* BbPlatform;

  const configureProject = (input: ProjectConfigInput) => Effect.gen(function*() {
    const previous = yield* store.getProject(input.projectId).pipe(
      Effect.catchIf((error) => error.code === "project_not_configured", () => Effect.succeed(undefined)),
    );
    const config = yield* normalizeProjectConfig(input, previous);
    yield* assertGitName(config.remoteName, "remoteName"); yield* assertGitName(config.baseBranch, "baseBranch");
    return yield* store.putProject(config);
  });
  const loadProjectConfigFile = (projectId: string, filePath: string) => Effect.gen(function*() {
    const content = yield* bb.readTextFile(filePath);
    return consumerConfigToInput(projectId, yield* parseConsumerProjectConfig(content, filePath));
  });
  const diffProjectConfigFile = (projectId: string, filePath: string) => Effect.gen(function*() {
    const input = yield* loadProjectConfigFile(projectId, filePath);
    const current = yield* store.getProject(projectId).pipe(
      Effect.catchIf((error) => error.code === "project_not_configured", () => Effect.succeed(undefined)),
    );
    const desired = yield* normalizeProjectConfig(input, current, current?.updatedAt ?? Date.now());
    yield* assertGitName(desired.remoteName, "remoteName"); yield* assertGitName(desired.baseBranch, "baseBranch");
    return diffProjectConfig(projectId, filePath, current, desired);
  });
  const doctor = (projectId: string) => Effect.gen(function*() {
    const config = yield* store.getProject(projectId);
    const provider = providers[config.provider];
    yield* provider.whoami;
    if (provider.inspectSnapshot) {
      const snapshot = yield* provider.inspectSnapshot(config.templateVm);
      return { ok: snapshot.state === "active", projectId, templateVm: config.templateVm, templateStatus: snapshot.state, baseSha: null, copiedBbIdentityCount: null,
        checks: [{ name: "snapshot active", ok: snapshot.state === "active", message: `Snapshot ${snapshot.state}; repository and bb identity are checked during creation.` }] };
    }
    const template = (yield* provider.listVms).find((vm) => vm.name === config.templateVm);
    if (!template) return yield* bbRemoteWorkspacesError("template_not_found", `Template VM ${config.templateVm} does not exist.`);
    const remote = yield* provider.runScript(config.templateVm, DOCTOR_REPOSITORY_SCRIPT, [config.repoPath, config.remoteName, config.baseBranch], RemotePrepareResult);
    const checks = [
      { name: "template VM", ok: template.status.toLowerCase() === "running", message: `status: ${template.status}` },
      { name: "repository clean", ok: remote.clean, message: remote.clean ? "working tree clean" : "template has local changes" },
      { name: "bb identity absent", ok: remote.copiedBbIdentityCount === 0, message: remote.copiedBbIdentityCount === 0 ? "no copied bb identity detected" : `${remote.copiedBbIdentityCount} identity file(s) detected` },
    ];
    return { ok: checks.every((c) => c.ok), projectId, templateVm: config.templateVm, templateStatus: template.status, baseSha: remote.baseSha, copiedBbIdentityCount: remote.copiedBbIdentityCount, checks };
  });

  const create = (input: CreateWorkspaceInput) => Effect.gen(function*() {
    if (input.prompt.trim() === "") return yield* bbRemoteWorkspacesError("empty_prompt", "A workspace prompt is required.");
    const config = yield* store.getProject(input.projectId);
    const provider = providers[config.provider];
    const id = randomUUID(); const branchName = `bb-remote-workspaces/${id}`; const name = vmName(input.projectId, id); const now = Date.now();
    const record: WorkspaceRecord = { provider: config.provider, config, id, projectId: input.projectId, state: "requested", desiredState: "ready", vmName: name, hostId: null, environmentId: null, rootThreadId: null, baseRef: `${config.remoteName}/${config.baseBranch}`, baseSha: null, branchName, cleanupAfter: null, retentionReason: null, lastErrorCode: null, lastErrorMessage: null, createdAt: now, updatedAt: now, readyAt: null, deletedAt: null };
    yield* store.insertWorkspace(record);
    const advance = (patch: Parameters<typeof store.updateWorkspace>[1]) => store.updateWorkspace(id, patch);
    return yield* Effect.gen(function*() {
      yield* advance({ state: "cloning" });
      const resourceId = yield* provider.copyVm(config.templateVm, name, config);
      if (resourceId) yield* advance({ providerResourceId: resourceId });
      yield* advance({ state: "marking" }); yield* provider.markVm(name, id, input.projectId);
      yield* advance({ state: "preparing_repo" });
      const prepared = yield* provider.runScript(name, PREPARE_REPOSITORY_SCRIPT, [config.repoPath, config.remoteName, config.baseBranch, branchName, id, input.projectId], RemotePrepareResult);
      if (!prepared.clean) return yield* bbRemoteWorkspacesError("template_repo_dirty", "Template repository has local changes; refusing to overwrite them.");
      if (prepared.copiedBbIdentityCount > 0) return yield* bbRemoteWorkspacesError("copied_bb_identity", "Template contains a bb host identity; remove it before cloning.");
      yield* advance({ state: "enrolling", baseSha: prepared.baseSha });
      const enrollment = yield* bb.enrollHost(config.serverMode, config.directServerUrl);
      yield* advance({ state: "connecting", hostId: enrollment.hostId });
      yield* provider.runCommand(name, installBbCommand(enrollment.serverUrl, enrollment.joinCode, enrollment.hostId, enrollment.machineCode));
      yield* bb.waitForHost(enrollment.hostId, `${config.provider} ${input.projectId} ${id.slice(0, 8)}`);
      yield* advance({ state: "spawning" });
      const thread = yield* bb.spawnThread(enrollment.hostId, config.repoPath, input);
      return yield* advance({ state: "ready", environmentId: thread.environmentId, rootThreadId: thread.id, readyAt: Date.now(), lastErrorCode: null, lastErrorMessage: null });
    }).pipe(Effect.matchEffect({
      onFailure: (error) => store.updateWorkspace(id, { state: "error", lastErrorCode: error.code, lastErrorMessage: error.message }).pipe(Effect.andThen(Effect.fail(error))),
      onSuccess: (workspace) => Effect.succeed(workspace),
    }));
  });

  const destroy = (input: DestroyWorkspaceInput) => Effect.gen(function*() {
    const record = yield* store.getWorkspace(input.workspaceId);
    if (record.state === "deleted") return record;
    const config = record.config ?? (yield* store.getProject(record.projectId));
    const provider = providers[record.provider];
    const providerVm = (yield* provider.listVms).find((vm) => vm.name === record.vmName);
    if (!providerVm || !provider.ownsVm(providerVm, record))
      return yield* bbRemoteWorkspacesError("provider_ownership_mismatch", "Provider ownership does not match; refusing deletion.");
    const inspection = yield* provider.runScript(record.vmName, INSPECT_REPOSITORY_SCRIPT, [config.repoPath, config.remoteName, config.baseBranch, record.branchName, record.id], RemoteInspection);
    const force = input.force ?? false;
    if (!inspection.markerMatches) return yield* bbRemoteWorkspacesError("ownership_marker_mismatch", "Remote ownership marker does not match; refusing deletion.");
    if (!force && (!inspection.clean || inspection.ahead > 0)) return yield* bbRemoteWorkspacesError("workspace_not_safe", `Workspace has ${inspection.clean ? "committed" : "uncommitted"} changes; retain it or use human-only --force.`);
    if (!force && record.environmentId !== null) {
      const environment = yield* bb.inspectEnvironment(record.environmentId);
      if (!environment.safe) return yield* bbRemoteWorkspacesError("environment_in_use", `Environment still has ${environment.openThreadIds.length} open thread(s) and ${environment.activeTerminalIds.length} active terminal(s).`);
    }
    yield* store.updateWorkspace(record.id, { state: "deleting", desiredState: "deleted" });
    if (record.environmentId !== null) yield* bb.archiveEnvironment(record.environmentId);
    if (record.hostId !== null) yield* bb.deleteHost(record.hostId);
    yield* provider.removeVm(record.vmName, record.providerResourceId);
    return yield* store.updateWorkspace(record.id, { state: "deleted", desiredState: "deleted", deletedAt: Date.now(), cleanupAfter: null });
  });

  const scheduleCleanupForThread = (threadId: string) => Effect.gen(function*() {
    const records = yield* store.listWorkspaces(); const record = records.find((r) => r.rootThreadId === threadId);
    if (!record || record.desiredState === "retained" || record.state === "deleted") return;
    const config = record.config ?? (yield* store.getProject(record.projectId));
    yield* store.updateWorkspace(record.id, { state: "cleanup_scheduled", cleanupAfter: Date.now() + config.cleanupGraceMinutes * 60_000 });
  });
  const reconcile = Effect.gen(function*() {
    const now = Date.now(); const records = yield* store.listWorkspaces();
    const deleting = records.filter((record) => record.state === "deleting" && record.desiredState === "deleted");
    if (deleting.length > 0) {
      for (const record of deleting) {
        const resume = Effect.gen(function*() {
        const providerVms = yield* providers[record.provider].listVms;
        return yield* providerVms.some((vm) => vm.name === record.vmName)
          ? destroy({ workspaceId: record.id, force: true }).pipe(Effect.asVoid)
          : Effect.gen(function*() {
              if (record.environmentId !== null) yield* bb.archiveEnvironment(record.environmentId).pipe(Effect.matchEffect({ onFailure: (error) => bb.logError(error.message), onSuccess: () => Effect.void }));
              if (record.hostId !== null) yield* bb.deleteHost(record.hostId).pipe(Effect.matchEffect({ onFailure: (error) => bb.logError(error.message), onSuccess: () => Effect.void }));
              yield* store.updateWorkspace(record.id, { state: "deleted", desiredState: "deleted", deletedAt: Date.now(), cleanupAfter: null });
            });
        });
        yield* resume.pipe(Effect.matchEffect({ onFailure: (error) => bb.logError(`resume deletion ${record.id}: ${error.message}`), onSuccess: () => Effect.void }));
      }
    }
    const scheduled = records.filter((r) => r.state === "cleanup_scheduled" && r.desiredState === "ready" && r.cleanupAfter !== null);
    const due: WorkspaceRecord[] = [];
    for (const record of scheduled) {
      if (record.rootThreadId !== null && !(yield* bb.getThread(record.rootThreadId)).archived) {
        yield* store.updateWorkspace(record.id, { state: "ready", cleanupAfter: null });
      } else if (record.cleanupAfter! <= now) due.push(record);
    }
    yield* Effect.forEach(due, (record) => destroy({ workspaceId: record.id }).pipe(Effect.matchEffect({
      onFailure: (error) => error.retryable
        ? bb.logError(`cleanup ${record.id}: ${error.message}`)
        : store.updateWorkspace(record.id, { state: "retained", desiredState: "retained", retentionReason: error.message, cleanupAfter: null }).pipe(Effect.asVoid),
      onSuccess: () => Effect.void,
    })), { concurrency: 2 });
  }).pipe(Effect.asVoid);
  return {
    configureProject, getProject: store.getProject, loadProjectConfigFile, diffProjectConfigFile, doctor, create, get: store.getWorkspace, list: store.listWorkspaces,
    retain: (id, reason) => store.updateWorkspace(id, { state: "retained", desiredState: "retained", retentionReason: reason, cleanupAfter: null }),
    scheduleCleanupForThread, destroy, reconcile,
  } satisfies OrchestratorShape;
}));
