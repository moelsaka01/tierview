import { defineConfig } from "tsup";

// dist/bin.js: the npm CLI (dependencies stay external, installed by npm).
// dist/action.js: the GitHub Action, one self-contained file committed to the repo (a runner does not npm install).
export default defineConfig([
  { entry: ["src/bin.ts"], format: ["esm"], target: "node22", clean: false, splitting: false },
  {
    entry: ["src/action.ts"],
    format: ["esm"],
    target: "node22",
    clean: false,
    splitting: false,
    noExternal: [/.*/],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  },
]);
