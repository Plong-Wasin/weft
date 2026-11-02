import { createAuthClient } from "better-auth/react";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { api } from "./api";

export const authClient = createAuthClient({
  baseURL: `${api}/api/auth`,
  plugins: [oauthProviderClient()],
});
