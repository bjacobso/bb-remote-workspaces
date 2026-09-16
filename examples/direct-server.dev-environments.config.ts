import { Effect } from "effect";
import {
  cleanup,
  compute,
  defineSetup,
  environment,
  repository,
  server,
  synthesizeJson,
} from "../src/dsl.js";

// A directly reachable bb server, a non-default Git branch, and an explicit
// resource/retention policy. Credentials still live in bb plugin settings.
const setup = defineSetup({
  default: "integration",
  environments: {
    integration: environment({
      compute: compute.exe({
        template: "integration-main",
        resources: {
          cpu: 8,
          memory: "16GB",
          disk: "100GB",
          pool: "ci",
        },
      }),
      repository: repository({
        path: "/srv/checkout",
        remote: "upstream",
        base: "develop",
      }),
      server: server.direct("https://bb.example.com"),
      cleanup: cleanup({ graceMinutes: 120 }),
    }),
  },
});

process.stdout.write(await Effect.runPromise(synthesizeJson(setup)));
