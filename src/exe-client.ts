import { Context, Effect, Layer, Schema } from "effect";
import { asBbExeError, bbExeError, errorMessage, redactSecrets, type BbExeError } from "./errors.js";
import { formatCommand, quoteShellArgument } from "./shell.js";
import { decodeUnknown } from "./types.js";

export const DEFAULT_API_URL = "https://exe.dev/exec";
export interface ExeVm { readonly name: string; readonly status: string; readonly tags: ReadonlyArray<string>; readonly comment: string | null; readonly raw: unknown }
export interface ExeClientShape {
  readonly execute: (args: ReadonlyArray<string>) => Effect.Effect<unknown, BbExeError>;
  readonly whoami: Effect.Effect<unknown, BbExeError>;
  readonly listVms: Effect.Effect<ReadonlyArray<ExeVm>, BbExeError>;
  readonly copyVm: (source: string, destination: string, resources: { readonly cpu: number | null; readonly memory: string | null; readonly disk: string | null; readonly pool: string | null }) => Effect.Effect<void, BbExeError>;
  readonly markVm: (vmName: string, workspaceId: string, projectId: string) => Effect.Effect<void, BbExeError>;
  readonly removeVm: (vmName: string) => Effect.Effect<void, BbExeError>;
  readonly runScript: <S extends Schema.Constraint & { readonly DecodingServices: never }>(vmName: string, script: string, args: ReadonlyArray<string>, output: S) => Effect.Effect<S["Type"], BbExeError>;
}
export class ExeClient extends Context.Service<ExeClient, ExeClientShape>()("bb-exe/ExeClient") {}

function asRecord(value: unknown): Record<string, unknown> | null { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null }
function firstString(record: Record<string, unknown>, keys: ReadonlyArray<string>): string | null { for (const key of keys) if (typeof record[key] === "string") return record[key]; return null }
function normalizeTags(value: unknown): ReadonlyArray<string> { return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : typeof value === "string" ? value.split(/[\s,]+/).filter(Boolean) : [] }

export function normalizeVmList(payload: unknown): ReadonlyArray<ExeVm> {
  const root = asRecord(payload);
  const candidates = Array.isArray(payload) ? payload : Array.isArray(root?.vms) ? root.vms : Array.isArray(root?.results) ? root.results : [];
  return candidates.flatMap((candidate) => {
    const record = asRecord(candidate); const name = record === null ? null : firstString(record, ["vm_name", "name", "vmName"]);
    return record === null || name === null ? [] : [{ name, status: firstString(record, ["status", "state"]) ?? "unknown", tags: normalizeTags(record.tags), comment: firstString(record, ["comment", "description"]), raw: candidate }];
  });
}
export function extractTextOutput(payload: unknown): string {
  if (typeof payload === "string") return payload;
  const record = asRecord(payload); if (record === null) return JSON.stringify(payload);
  for (const key of ["stdout", "output", "text", "message"] as const) if (typeof record[key] === "string") return record[key];
  for (const key of ["result", "data"] as const) if (record[key] !== undefined) return extractTextOutput(record[key]);
  return JSON.stringify(payload);
}
function parseLastJsonLine<S extends Schema.Constraint & { readonly DecodingServices: never }>(payload: unknown, schema: S): Effect.Effect<S["Type"], BbExeError> {
  const text = extractTextOutput(payload).trim();
  return Effect.try({
    try: () => {
      for (const line of text.split("\n").reverse()) {
        try { return Schema.decodeUnknownSync(schema)(JSON.parse(line) as unknown); } catch { /* remote progress or another JSON shape */ }
      }
      throw bbExeError("invalid_remote_output", `Remote command did not return expected JSON: ${redactSecrets(text)}`);
    },
    catch: (error) => asBbExeError(error, "invalid_remote_output"),
  });
}
export interface ExeClientOptions { readonly getToken: Effect.Effect<string | undefined, BbExeError>; readonly apiUrl?: string; readonly fetch?: typeof fetch }

export function makeExeClientLayer(options: ExeClientOptions): Layer.Layer<ExeClient> {
  return Layer.succeed(ExeClient, (() => {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const execute = (args: ReadonlyArray<string>) => Effect.gen(function*() {
      const token = (yield* options.getToken)?.trim();
      if (!token) return yield* bbExeError("missing_exe_token", "Configure the exe.dev API token before using bb-exe.");
      const command = yield* Effect.try({ try: () => formatCommand(args), catch: (error) => asBbExeError(error, "invalid_exe_command") });
      const response = yield* Effect.tryPromise({
        try: (signal) => fetchImpl(options.apiUrl ?? DEFAULT_API_URL, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "text/plain; charset=utf-8" }, body: command, signal }),
        catch: (cause) => bbExeError("exe_network_error", errorMessage(cause), true),
      });
      const body = yield* Effect.tryPromise({ try: () => response.text(), catch: (cause) => bbExeError("exe_response_error", errorMessage(cause), true) });
      if (!response.ok) return yield* bbExeError("exe_api_error", `exe.dev returned HTTP ${response.status}: ${redactSecrets(body)}`, response.status === 429 || response.status >= 500);
      if (body.trim() === "") return null;
      try { return JSON.parse(body) as unknown; } catch { return body; }
    });
    const runScript: ExeClientShape["runScript"] = (vmName, script, args, output) => {
      const encoded = Buffer.from(script, "utf8").toString("base64");
      const remote = ["printf %s", quoteShellArgument(encoded), "| base64 -d | bash -s --", ...args.map(quoteShellArgument)].join(" ");
      return execute(["ssh", vmName, "bash", "-lc", remote]).pipe(Effect.flatMap((payload) => parseLastJsonLine(payload, output)));
    };
    return {
      execute, whoami: execute(["whoami"]), listVms: execute(["ls"]).pipe(Effect.map(normalizeVmList)),
      copyVm: (source, destination, r) => { const args = ["cp", source, destination, "--copy-tags=false"]; if (r.cpu !== null) args.push(`--cpu=${r.cpu}`); if (r.memory !== null) args.push(`--memory=${r.memory}`); if (r.disk !== null) args.push(`--disk=${r.disk}`); if (r.pool !== null) args.push(`--pool=${r.pool}`); return execute(args).pipe(Effect.asVoid); },
      markVm: (vm, workspace, project) => Effect.all([execute(["tag", vm, "bb-exe", `bb-exe-${workspace.slice(0, 8).toLowerCase()}`]), execute(["comment", vm, `bb-exe workspace=${workspace} project=${project}`])]).pipe(Effect.asVoid),
      removeVm: (vm) => execute(["rm", vm]).pipe(Effect.asVoid), runScript,
    };
  })());
}
