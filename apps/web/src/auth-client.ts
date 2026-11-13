import { createAuthClient } from "better-auth/react";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { api } from "./api";

export const authClient = createAuthClient({
  // better-auth rejects a relative base URL, so the single-origin build (empty VITE_API_URL) uses the page origin.
  baseURL: `${api || window.location.origin}/api/auth`,
  plugins: [oauthProviderClient()],
});
