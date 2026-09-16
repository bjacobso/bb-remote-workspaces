import { Effect } from "effect";
import {
  cleanup,
  compute,
  defineSetup,
  environment,
  repository,
  synthesizeJson,
} from "../src/dsl.js";

const app = repository({
  path: "/workspace/app",
  remote: "origin",
  base: "main",
});

const standard = compute.exe({
  template: "app-main",
  resources: { cpu: 4, memory: "8GB" },
});

export const setup = defineSetup({
  default: "development",
  environments: {
    development: environment({
      compute: standard,
      repository: app,
    }),
    largeTest: environment({
      compute: compute.exe({
        template: "app-main",
        resources: { cpu: 16, memory: "32GB", disk: "100GB" },
      }),
      repository: app,
      cleanup: cleanup({ graceMinutes: 60 }),
    }),
    review: environment({
      compute: compute.amika({ template: "app-snapshot" }),
      repository: app,
    }),
  },
});

const target = process.argv[2];
process.stdout.write(await Effect.runPromise(synthesizeJson(setup, target === undefined ? {} : { environment: target })));
