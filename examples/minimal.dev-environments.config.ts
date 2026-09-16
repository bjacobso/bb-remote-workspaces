import { Effect } from "effect";
import {
  compute,
  defineSetup,
  environment,
  repository,
  synthesizeJson,
} from "../src/dsl.js";

// The smallest useful setup: one warm Exe template and one repository checkout.
const setup = defineSetup({
  default: "development",
  environments: {
    development: environment({
      compute: compute.exe({ template: "app-main" }),
      repository: repository({ path: "/workspace/app" }),
    }),
  },
});

process.stdout.write(await Effect.runPromise(synthesizeJson(setup)));
