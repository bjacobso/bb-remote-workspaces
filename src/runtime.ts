import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { Effect, Layer, ManagedRuntime } from "effect";
import { makeBbPlatformLayer, type BbExeSettings } from "./bb-platform.js";
import { asBbExeError } from "./errors.js";
import type { BbExeError } from "./errors.js";
import { makeExeClientLayer } from "./exe-client.js";
import { Orchestrator, OrchestratorLive } from "./orchestrator.js";
import { makeWorkspaceStoreLayer } from "./store.js";

export class BbExtensionRuntime {
  readonly #runtime: ManagedRuntime.ManagedRuntime<Orchestrator, BbExeError>;

  constructor(bb: BbPluginApi, settings: BbExeSettings) {
    const bbLayer = makeBbPlatformLayer(bb, settings);
    const storeLayer = makeWorkspaceStoreLayer(bb.storage.database(), (db, statements) => bb.storage.migrate(db, statements));
    const exeLayer = makeExeClientLayer({
      getToken: Effect.tryPromise({ try: () => settings.get(), catch: (error) => asBbExeError(error, "settings_read_failed") }).pipe(Effect.map((values) => values.exeToken)),
    });
    const dependencies = Layer.mergeAll(bbLayer, storeLayer, exeLayer);
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
