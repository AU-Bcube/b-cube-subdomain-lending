import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { netlifyFunctions } from "./scripts/vite-functions";

export default defineConfig({
  // netlifyFunctions(): dev/preview 서버에서 /api/*, /auth/*를 Netlify 함수로 보내고 .env를 읽는다.
  plugins: [react(), netlifyFunctions()],
  // APP_ORIGIN(http://localhost:5173)과 Origin 검사를 맞추기 위해 dev/preview 모두 5173을 쓴다.
  server: { port: 5173, strictPort: true },
  preview: { allowedHosts: ["0.tcp.jp.ngrok.io"], port: 5173, strictPort: true },
  environments: {
    client: {
      build: {
        rolldownOptions: {
          output: {
            // 자주 바뀌지 않는 라이브러리를 앱 코드와 나눠 캐시를 오래 쓰게 한다.
            codeSplitting: {
              groups: [
                { name: "react", test: /node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/ },
                { name: "carbon", test: /node_modules[\\/]@carbon[\\/]/ },
              ],
            },
          },
        },
      },
    },
  },
  css: {
    preprocessorOptions: {
      scss: { quietDeps: true, silenceDeprecations: ["import", "global-builtin", "if-function"] },
    },
  },
});
