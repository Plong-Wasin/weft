import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";

export function createHocuspocusProvider(url: string, name: string, token: string, doc = new Y.Doc()) {
  const provider = new HocuspocusProvider({ url, name, document: doc, token });
  const synced = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for document sync")), 5_000);
    provider.on("synced", () => { clearTimeout(timeout); resolve(); });
    provider.on("authenticationFailed", ({ reason }: { reason: string }) => { clearTimeout(timeout); reject(new Error(reason)); });
  });
  return {
    doc,
    synced,
    waitFor: async (condition: () => boolean) => {
      for (let attempt = 0; attempt < 150 && !condition(); attempt++) await Bun.sleep(20);
      if (!condition()) throw new Error(`Timed out waiting for remote update (socket ${provider.configuration.websocketProvider.status})`);
    },
    destroy: () => { provider.destroy(); doc.destroy(); },
  };
}
