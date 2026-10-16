import { defineConfig } from "vite";
const BUILD_ID = String(Date.now());
// every build gets an id; the app compares it with /version.json to tell people when a newer version is live
export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  build: { chunkSizeWarningLimit: 1500 },
  plugins: [{ name: "version-file", generateBundle() { this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ id: BUILD_ID }) }); } }],
});
