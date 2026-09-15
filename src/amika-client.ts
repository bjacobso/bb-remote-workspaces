import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Effect, Schema } from "effect";
import { bbRemoteWorkspacesError, type BbRemoteWorkspacesError } from "./errors.js";
import { parseLastJsonLine } from "./exe-client.js";
import type { WorkspaceProvider } from "./providers.js";
import { quoteShellArgument } from "./shell.js";
import { decodeUnknown } from "./types.js";

const execFileAsync = promisify(execFile);
const Sandbox = Schema.Struct({ id: Schema.String, name: Schema.String, status: Schema.String, setup_status: Schema.optionalKey(Schema.NullOr(Schema.String)) });
export interface AmikaClientOptions {
  readonly getToken: Effect.Effect<string | undefined, BbRemoteWorkspacesError>;
  readonly fetch?: typeof fetch;
  readonly runSsh?: (args: string[], token: string, signal: AbortSignal) => Promise<string>;
}

export function makeAmikaClient(options: AmikaClientOptions): WorkspaceProvider {
  const token = options.getToken.pipe(Effect.flatMap(value => value?.trim()
    ? Effect.succeed(value.trim())
    : Effect.fail(bbRemoteWorkspacesError("missing_amika_token", "Configure the Amika API token before using this provider."))));
  const request = (method: string, path: string, body?: unknown) => Effect.gen(function*() {
    const credential = yield* token;
    const response = yield* Effect.tryPromise({
      try: signal => (options.fetch ?? globalThis.fetch)(`https://app.amika.dev/api/v0beta1${path}`, {
        method, headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal,
      }),
      catch: () => bbRemoteWorkspacesError("amika_network_error", "Amika request failed.", true),
    });
    // Provider errors may echo credentials or command bodies; never persist their raw text.
    if (!response.ok) return yield* bbRemoteWorkspacesError("amika_api_error", `Amika returned HTTP ${response.status}.`, response.status === 429 || response.status >= 500);
    return yield* Effect.tryPromise({ try: () => response.json() as Promise<unknown>, catch: () => bbRemoteWorkspacesError("amika_response_error", "Amika returned invalid JSON.") });
  });
  const getSandbox = (name: string) => request("GET", `/sandboxes/${encodeURIComponent(name)}`).pipe(Effect.flatMap(value => decodeUnknown(Sandbox, value, "Amika sandbox")));
  const runCommand: WorkspaceProvider["runCommand"] = (name, command) => Effect.gen(function*() {
    const credential = yield* token;
    const args = ["sandbox", "--remote", "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=30", name, `bash -lc ${quoteShellArgument(command)}`];
    return yield* Effect.tryPromise({
      try: signal => options.runSsh ? options.runSsh(args, credential, signal) : execFileAsync("amika", args, {
        env: { ...process.env, AMIKA_API_KEY: credential, AMIKA_API_URL: "https://app.amika.dev" }, signal, timeout: 300_000, maxBuffer: 4 * 1024 * 1024,
      }).then(result => result.stdout),
      catch: () => bbRemoteWorkspacesError("amika_ssh_failed", "Amika SSH failed. Check CLI installation, SSH identity, and sandbox connectivity."),
    });
  });
  const listVms = request("GET", "/sandboxes").pipe(
    Effect.flatMap(value => decodeUnknown(Schema.Array(Sandbox), value, "Amika sandboxes")),
    Effect.map(items => items.map(item => ({ name: item.name, status: item.status, tags: [], comment: null, raw: item }))),
  );
  return {
    whoami: listVms, listVms,
    inspectSnapshot: name => request("GET", `/sandbox-snapshots/${encodeURIComponent(name)}?by=ref`).pipe(
      Effect.flatMap(value => decodeUnknown(Schema.Struct({ state: Schema.String }), value, "Amika snapshot")),
    ),
    copyVm: (source, destination) => Effect.gen(function*() {
      const created = yield* request("POST", "/sandboxes", { name: destination, snapshot: source, auto_stop_interval: 0, auto_delete_interval: -1 }).pipe(
        Effect.flatMap(value => decodeUnknown(Sandbox, value, "created Amika sandbox")),
      );
      if (created.name !== destination) return yield* bbRemoteWorkspacesError("amika_response_error", "Created sandbox name does not match the request.");
      return created.id;
    }),
    markVm: (name) => Effect.gen(function*() {
      for (let attempt = 0; attempt < 120; attempt++) {
        const sandbox = yield* getSandbox(name);
        if (sandbox.status === "failed" || ["git-failed", "setup-failed", "sys-setup-failed"].includes(sandbox.setup_status ?? ""))
          return yield* bbRemoteWorkspacesError("amika_provision_failed", "Amika sandbox provisioning failed.");
        if (sandbox.status === "running" && sandbox.setup_status !== "setup-running") return;
        yield* Effect.sleep("3 seconds");
      }
      return yield* bbRemoteWorkspacesError("amika_provision_timeout", "Amika sandbox did not become ready within six minutes.", true);
    }),
    ownsVm: (machine, record) => {
      const raw = machine.raw as { id?: unknown };
      return typeof record.providerResourceId === "string" && raw.id === record.providerResourceId;
    },
    removeVm: (name, resourceId) => request("DELETE", `/sandboxes/${encodeURIComponent(resourceId ?? name)}`).pipe(Effect.asVoid),
    runCommand,
    runScript: (name, script, args, output) => {
      const encoded = Buffer.from(script, "utf8").toString("base64");
      const command = `printf %s ${quoteShellArgument(encoded)} | base64 -d | bash -s -- ${args.map(quoteShellArgument).join(" ")}`;
      return runCommand(name, command).pipe(Effect.flatMap(value => parseLastJsonLine(value, output)));
    },
  };
}
