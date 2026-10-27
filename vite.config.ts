import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [react(), cloudflare()],
  // APP_ORIGIN(http://localhost:5173)과 Origin 검사를 맞추기 위해 dev/preview 모두 5173을 쓴다.
  server: { port: 5173, strictPort: true },
  preview: { allowedHosts: ["0.tcp.jp.ngrok.io"], port: 5173, strictPort: true },
  css: {
    preprocessorOptions: {
      scss: { quietDeps: true, silenceDeprecations: ["import", "global-builtin", "if-function"] },
    },
  },
});
