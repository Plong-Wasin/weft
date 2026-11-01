import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { translate } from "@weft/shared";

// Static page (no JS) so it renders offline; strings come from the i18n resources.
function offlinePage(): Plugin {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${translate("offline.title")}</title>
<style>body{margin:0;font-family:system-ui,sans-serif;color:#202b2a;background:#f5f8f6;display:grid;place-items:center;min-height:100vh}main{max-width:28rem;padding:2rem;text-align:center}</style></head>
<body><main><h1>${translate("offline.title")}</h1><p>${translate("offline.body")}</p><button onclick="location.reload()">${translate("offline.retry")}</button></main></body></html>`;
  return { name: "weft-offline-page", generateBundle() { this.emitFile({ type: "asset", fileName: "offline.html", source: html }); } };
}

export default defineConfig({
  plugins: [
    react(),
    offlinePage(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "autoUpdate",
      injectManifest: { globPatterns: ["**/*.{js,css,html,png,svg}"] },
      manifest: {
        name: "Weft",
        short_name: "Weft",
        start_url: "/",
        display: "standalone",
        background_color: "#f5f8f6",
        theme_color: "#1f6f54",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
      },
    }),
  ],
});
