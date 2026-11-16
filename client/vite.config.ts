import basicSsl from "@vitejs/plugin-basic-ssl";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const serverUrl = env.DEV_SERVER_PROXY_TARGET || "http://localhost:3001";
  const https = mode === "https";

  return {
    plugins: [react(), tailwindcss(), ...(https ? [basicSsl({ name: "dropflow-dev" })] : [])],
    server: {
      host: true,
      port: Number(env.CLIENT_PORT) || 5173,
      proxy: {
        "/health": serverUrl,
        "/socket.io": { target: serverUrl, ws: true },
      },
    },
  };
});
