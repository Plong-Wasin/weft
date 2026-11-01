import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
// A relative path, not "@weft/shared": Vite bundles relative imports into its config, but loads a workspace package through Node, which cannot resolve its extensionless TypeScript imports.
import { translate } from "../../packages/shared/src/index";

// Static page so it renders offline. Every language is emitted; a tiny inline script shows the one the user chose
// (same storage key as the app) or the browser language. Without JS the English text shows.
function offlinePage(): Plugin {
  const section = (locale: "en" | "th", hidden: boolean) => `<main lang="${locale}" data-locale="${locale}"${hidden ? " hidden" : ""}><h1>${translate("offline.title", locale)}</h1><p>${translate("offline.body", locale)}</p><button onclick="location.reload()">${translate("offline.retry", locale)}</button></main>`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${translate("offline.title", "en")}</title>
<style>body{margin:0;font-family:system-ui,sans-serif;color:#202b2a;background:#f5f8f6;display:grid;place-items:center;min-height:100vh}main{max-width:28rem;padding:2rem;text-align:center}main[hidden]{display:none}</style></head>
<body>${section("en", false)}${section("th", true)}<script>(function(){var l;try{l=localStorage.getItem("weft.locale")}catch(e){}if(l!=="en"&&l!=="th")l=/^th/i.test(navigator.language||"")?"th":"en";document.documentElement.lang=l;document.title=l==="th"?${JSON.stringify(translate("offline.title", "th"))}:${JSON.stringify(translate("offline.title", "en"))};var m=document.querySelectorAll("main");for(var i=0;i<m.length;i++)m[i].hidden=m[i].getAttribute("data-locale")!==l}())</script></body></html>`;
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
