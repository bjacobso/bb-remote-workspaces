import { makeAmikaClient } from "./amika-client.js";
import { WorkspaceProviders } from "./providers.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { Effect, Layer, ManagedRuntime } from "effect";
import { makeBbPlatformLayer, type BbRemoteWorkspacesSettings } from "./bb-platform.js";
import { asBbRemoteWorkspacesError } from "./errors.js";
import type { BbRemoteWorkspacesError } from "./errors.js";
import { ExeClient, makeExeClientLayer } from "./exe-client.js";
import { Orchestrator, OrchestratorLive } from "./orchestrator.js";
import { makeWorkspaceStoreLayer } from "./store.js";

export class BbExtensionRuntime {
  readonly #runtime: ManagedRuntime.ManagedRuntime<Orchestrator, BbRemoteWorkspacesError>;

  constructor(bb: BbPluginApi, settings: BbRemoteWorkspacesSettings) {
    const bbLayer = makeBbPlatformLayer(bb, settings);
    const storeLayer = makeWorkspaceStoreLayer(bb.storage.database(), (db, statements) => bb.storage.migrate(db, statements));
    const exeLayer = makeExeClientLayer({
      getToken: Effect.tryPromise({ try: () => settings.get(), catch: (error) => asBbRemoteWorkspacesError(error, "settings_read_failed") }).pipe(Effect.map((values) => values.exeToken)),
    });
    const providerLayer = Layer.effect(WorkspaceProviders, Effect.gen(function*() {
      const exe = yield* ExeClient;
      const amika = makeAmikaClient({ getToken: Effect.tryPromise({ try: () => settings.get(), catch: error => asBbRemoteWorkspacesError(error, "settings_read_failed") }).pipe(Effect.map(values => values.amikaToken)) });
      return { exe, amika };
    })).pipe(Layer.provide(exeLayer));
    const dependencies = Layer.mergeAll(bbLayer, storeLayer, providerLayer);
    this.#runtime = ManagedRuntime.make(OrchestratorLive.pipe(Layer.provide(dependencies)));
  }

  run<A, E>(effect: Effect.Effect<A, E, Orchestrator>, signal?: AbortSignal): Promise<A> {
    return this.#runtime.runPromise(effect, signal === undefined ? undefined : { signal });
  }

  use<A, E>(f: (orchestrator: import("./orchestrator.js").OrchestratorShape) => Effect.Effect<A, E>, signal?: AbortSignal): Promise<A> {
    return this.run(Effect.flatMap(Orchestrator, f), signal);
  }

  dispose(): Promise<void> { return this.#runtime.dispose(); }
}
