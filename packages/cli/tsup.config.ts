import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  clean: true,
  target: "es2022",
  banner: { js: "#!/usr/bin/env node" },
  external: ["@stellar/stellar-sdk", "@kryon/sdk"],
});
