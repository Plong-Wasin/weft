import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import type { WebhookTarget } from "./outbound-webhook-network";

export type WebhookRequest = {
  target: WebhookTarget; headers: Record<string, string>; body: string;
  /** Idle limit between socket events. */
  timeoutMs: number;
  /** Overall limit for the whole send; defaults to webhookDeadlineMs. */
  deadlineMs?: number;
  /** Limit for opening the connection; defaults to webhookConnectTimeoutMs. */
  connectTimeoutMs?: number;
};
export type WebhookResponse = { status: number; excerpt: string | null };
/** Sends one POST. The default connects to target.address, never to a fresh DNS answer. */
export type WebhookTransport = (request: WebhookRequest) => Promise<WebhookResponse>;

const maxExcerptBytes = 4096;
/** Overall limit for one send, from connect to the last byte read. A receiver that trickles bytes cannot hold the job longer. */
export const webhookDeadlineMs = 10_000;
/** Limit for opening the connection (TCP and TLS), so a filtered port fails fast. */
export const webhookConnectTimeoutMs = 5_000;

/**
 * Connects to the address already validated by resolveWebhookTarget. The socket's lookup is pinned to that address, so
 * the name is resolved once per send; Host and SNI still carry the host name. Redirects are never followed: a 3xx is
 * returned as the answer and the delivery fails. Three limits apply: connect, idle (timeoutMs) and an overall deadline
 * (deadlineMs, default webhookDeadlineMs) that destroys the request. The response is cut off after 4 KB.
 */
export const pinnedTransport: WebhookTransport = ({ target, headers, body, timeoutMs, deadlineMs, connectTimeoutMs }) => new Promise((resolve, reject) => {
  const url = new URL(target.url);
  const secure = url.protocol === "https:";
  const pinned = (_host: string, options: { all?: boolean } | undefined, callback: (error: Error | null, address: unknown, family?: number) => void) => {
    if (options?.all) callback(null, [{ address: target.address, family: target.family }]);
    else callback(null, target.address, target.family);
  };
  const send = secure ? httpsRequest : httpRequest;
  let settled = false;
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const finish = (action: () => void) => {
    if (settled) return;
    settled = true;
    for (const timer of timers) clearTimeout(timer);
    action();
  };
  const timeout = (message: string) => {
    const error = new Error(message);
    error.name = "TimeoutError";
    return error;
  };
  const req = send({
    protocol: url.protocol, hostname: target.hostname, port: url.port || (secure ? 443 : 80), path: `${url.pathname}${url.search}`, method: "POST",
    headers: { ...headers, host: url.host }, lookup: pinned, ...(secure && !/^[\d.]+$|:/.test(target.hostname) ? { servername: target.hostname } : {}),
  } as RequestOptions, (response) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const answer = () => finish(() => resolve({ status: response.statusCode ?? 0, excerpt: Buffer.concat(chunks).toString("utf8").slice(0, 500) }));
    response.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= maxExcerptBytes) {
        // Enough to show; stop reading so a huge body cannot hold the connection.
        answer();
        response.destroy();
        req.destroy();
      }
    });
    response.on("end", answer);
    response.on("error", (error) => finish(() => reject(error)));
    response.on("close", answer);
  });
  const fail = (error: Error) => finish(() => { reject(error); req.destroy(); });
  timers.push(setTimeout(() => fail(timeout("timed out")), deadlineMs ?? timeoutMs ?? webhookDeadlineMs));
  req.on("socket", (socket) => {
    if (!socket.connecting) return;
    const connectTimer = setTimeout(() => fail(timeout("connect timed out")), connectTimeoutMs ?? webhookConnectTimeoutMs);
    timers.push(connectTimer);
    socket.once(secure ? "secureConnect" : "connect", () => clearTimeout(connectTimer));
  });
  req.setTimeout(timeoutMs, () => fail(timeout("timed out")));
  req.on("error", (error) => finish(() => reject(error)));
  req.end(body);
});
