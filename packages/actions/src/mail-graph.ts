import { MailDeliveryError, type Mailer, type OutgoingMail } from "./mail";

export const GRAPH_AUTHORITY_URL = "https://login.microsoftonline.com";
export const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
export const GRAPH_REQUEST_TIMEOUT_MS = 10_000;

/** The token is treated as expired this long before Microsoft says it expires. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const SAFE_GRAPH_CODE = /^[A-Za-z0-9_.-]{1,80}$/;

export interface GraphMailerOptions {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** The mailbox that sends every message. It is also the From address. */
  sender: string;
  /** Test seam: the token endpoint host. Defaults to Microsoft's commercial cloud. */
  authorityUrl?: string;
  /** Test seam: the Graph base URL, including `/v1.0`. Defaults to Microsoft's commercial cloud. */
  graphUrl?: string;
  /** Per HTTP request, token and sendMail alike. Defaults to GRAPH_REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Clock in epoch milliseconds. Defaults to Date.now. */
  now?: () => number;
}

interface CachedToken {
  value: string;
  refreshAt: number;
}

/**
 * Sends plain-text mail through Microsoft Graph `sendMail` as one sender mailbox, with app-only client credentials.
 * Failures become MailDeliveryError with a code such as `HTTP_403:ErrorAccessDenied`, `TIMEOUT` or `NETWORK`;
 * the secret, the token and the message never reach an error. There is no retry here.
 */
export function createGraphMailer(options: GraphMailerOptions): Mailer {
  const authorityUrl = (options.authorityUrl ?? GRAPH_AUTHORITY_URL).replace(/\/+$/, "");
  const graphUrl = (options.graphUrl ?? GRAPH_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? GRAPH_REQUEST_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const tokenUrl = `${authorityUrl}/${encodeURIComponent(options.tenantId)}/oauth2/v2.0/token`;
  const sendUrl = `${graphUrl}/users/${encodeURIComponent(options.sender)}/sendMail`;

  let token: CachedToken | null = null;
  let tokenInFlight: Promise<string> | null = null;

  async function post(url: string, init: { headers: Record<string, string>; body: string }, step: "TOKEN" | "HTTP"): Promise<string> {
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, { method: "POST", ...init, signal: AbortSignal.timeout(timeoutMs) });
      text = await response.text();
    } catch (error) {
      const name = (error as { name?: unknown } | null)?.name;
      throw new MailDeliveryError(name === "TimeoutError" || name === "AbortError" ? "TIMEOUT" : "NETWORK");
    }
    if (!response.ok) {
      const code = errorCodeFrom(text);
      const prefix = step === "TOKEN" ? "TOKEN_HTTP_" : "HTTP_";
      throw new MailDeliveryError(`${prefix}${response.status}${code ? `:${code}` : ""}`);
    }
    return text;
  }

  async function fetchToken(): Promise<string> {
    const body = new URLSearchParams({
      client_id: options.clientId,
      client_secret: options.clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }).toString();
    const text = await post(tokenUrl, { headers: { "content-type": "application/x-www-form-urlencoded" }, body }, "TOKEN");
    const issued = parseJson(text) as { access_token?: unknown; expires_in?: unknown } | null;
    if (typeof issued?.access_token !== "string" || typeof issued.expires_in !== "number") throw new MailDeliveryError("TOKEN_INVALID");
    const issuedAt = now();
    token = { value: issued.access_token, refreshAt: issuedAt + issued.expires_in * 1000 - TOKEN_REFRESH_MARGIN_MS };
    return token.value;
  }

  /** The cached token while it is outside the refresh margin; otherwise one shared request for all concurrent callers. */
  function accessToken(): Promise<string> {
    if (token && now() < token.refreshAt) return Promise.resolve(token.value);
    tokenInFlight ??= fetchToken().finally(() => { tokenInFlight = null; });
    return tokenInFlight;
  }

  return {
    async send(mail: OutgoingMail) {
      const bearer = await accessToken();
      const body = JSON.stringify({
        message: {
          subject: mail.subject,
          body: { contentType: "Text", content: mail.text },
          toRecipients: [{ emailAddress: { address: mail.to } }],
        },
        saveToSentItems: false,
      });
      try {
        await post(sendUrl, { headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body }, "HTTP");
      } catch (error) {
        // A rejected token must not be reused: the next send asks Microsoft again.
        if (error instanceof MailDeliveryError && error.code.startsWith("HTTP_401")) token = null;
        throw error;
      }
    },
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The Graph `error.code` (or the OAuth `error`) when the body carries a safe one; anything else is dropped. */
function errorCodeFrom(text: string): string | null {
  const parsed = parseJson(text) as { error?: unknown } | null;
  const error = parsed?.error;
  const code = typeof error === "string" ? error : typeof (error as { code?: unknown } | null)?.code === "string" ? (error as { code: string }).code : null;
  return code && SAFE_GRAPH_CODE.test(code) ? code : null;
}
