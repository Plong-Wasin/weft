/**
 * A local fake of the two Microsoft endpoints the Graph mailer uses: the OAuth token endpoint and Graph `sendMail`.
 * It listens on 127.0.0.1 only, keeps every request in memory, and answers with whatever the test configures.
 * No request leaves the machine.
 */
export interface TokenRequest {
  path: string;
  /** The form fields Microsoft expects for client credentials, decoded. */
  form: Record<string, string>;
}

export interface SendRequest {
  path: string;
  authorization: string | null;
  /** The parsed JSON body, as received. */
  body: unknown;
}

export interface FakeGraphOptions {
  /** Status for the token endpoint. Default 200. */
  tokenStatus?: number;
  /** Lifetime in seconds of issued tokens. Default 3600. */
  tokenExpiresIn?: number;
  /** Delay before the token endpoint answers, in milliseconds. */
  tokenDelayMs?: number;
  /** Status for sendMail. Default 202. */
  sendStatus?: number;
  /** Delay before sendMail answers, in milliseconds. */
  sendDelayMs?: number;
  /** Graph error code returned with a non-2xx sendMail answer, e.g. "ErrorAccessDenied". */
  sendErrorCode?: string;
  /** Text placed in the error body. Tests use it to prove the transport never echoes response bodies. */
  errorMessage?: string;
}

export interface FakeGraph {
  /** Base for the token endpoint, e.g. http://127.0.0.1:41234 */
  authorityUrl: string;
  /** Base for Graph, e.g. http://127.0.0.1:41234/v1.0 */
  graphUrl: string;
  options: FakeGraphOptions;
  tokenRequests: TokenRequest[];
  sendRequests: SendRequest[];
  /** The access token the most recent token request was issued. */
  issuedTokens: string[];
  close(): void;
}

export function startFakeGraph(options: FakeGraphOptions = {}): FakeGraph {
  const state: FakeGraph = {
    authorityUrl: "",
    graphUrl: "",
    options,
    tokenRequests: [],
    sendRequests: [],
    issuedTokens: [],
    close() { server.stop(true); },
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = decodeURIComponent(url.pathname);

      if (request.method === "POST" && /^\/[^/]+\/oauth2\/v2\.0\/token$/.test(path)) {
        const form = Object.fromEntries(new URLSearchParams(await request.text()));
        state.tokenRequests.push({ path, form });
        if (state.options.tokenDelayMs) await Bun.sleep(state.options.tokenDelayMs);
        const status = state.options.tokenStatus ?? 200;
        if (status !== 200) {
          return Response.json({ error: "invalid_client", error_description: state.options.errorMessage ?? "AADSTS7000215: Invalid client secret." }, { status });
        }
        const token = `token-${state.issuedTokens.length + 1}`;
        state.issuedTokens.push(token);
        return Response.json({ token_type: "Bearer", expires_in: state.options.tokenExpiresIn ?? 3600, access_token: token });
      }

      if (request.method === "POST" && /^\/v1\.0\/users\/[^/]+\/sendMail$/.test(path)) {
        const body: unknown = await request.json();
        state.sendRequests.push({ path, authorization: request.headers.get("authorization"), body });
        if (state.options.sendDelayMs) await Bun.sleep(state.options.sendDelayMs);
        const status = state.options.sendStatus ?? 202;
        if (status >= 200 && status < 300) return new Response(null, { status });
        return Response.json(
          { error: { code: state.options.sendErrorCode ?? "ErrorGeneric", message: state.options.errorMessage ?? "Request failed." } },
          { status },
        );
      }

      return Response.json({ error: { code: "NotFound" } }, { status: 404 });
    },
  });

  state.authorityUrl = `http://127.0.0.1:${server.port}`;
  state.graphUrl = `http://127.0.0.1:${server.port}/v1.0`;
  return state;
}
