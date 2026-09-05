import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/server.ts"],
  format: ["esm"],
  dts: { entry: "src/index.ts" },
  clean: true,
  target: "es2022",
  banner: { js: "#!/usr/bin/env node" },
  external: ["@stellar/stellar-sdk", "@kryon/sdk", "@modelcontextprotocol/sdk", "zod"],
});
