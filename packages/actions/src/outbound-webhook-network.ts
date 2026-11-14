import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { ActionError } from "./members";
import { allowedWebhookPorts } from "./outbound-webhooks-flag";

export type AddressLookup = (hostname: string) => Promise<string[]>;
export class TransientWebhookLookupError extends Error {}
const transientDnsCodes = new Set(["EAI_AGAIN", "ETIMEDOUT", "SERVFAIL"]);
function lookupFailure(error: unknown): ActionError | TransientWebhookLookupError {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return transientDnsCodes.has(code ?? "") ? new TransientWebhookLookupError("The web address could not be looked up") : new ActionError("The web address could not be looked up", 400);
}

/** Looks up every address a host name resolves to. */
export const resolveAddresses: AddressLookup = async (hostname) => (await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

const maxUrlLength = 2000;

function ipv4Octets(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

/** IPv4 ranges a webhook must not reach by default: loopback, private, link-local (cloud metadata), shared, reserved and multicast. */
function isPrivateIpv4([a, b, c]: number[]): boolean {
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b! >= 16 && b! <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b! >= 64 && b! <= 127)
    || (a === 192 && b === 0)
    || (a === 192 && b === 88 && c === 99) // 6to4 relay anycast
    || (a === 198 && (b === 18 || b === 19)) // benchmarking 198.18.0.0/15
    || (a === 198 && b === 51 && c === 100) // TEST-NET-2
    || (a === 203 && b === 0 && c === 113) // TEST-NET-3
    || a >= 224;
}

/** Expands an IPv6 literal (as Node prints it, possibly with an embedded IPv4 tail) into eight 16-bit groups. */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase().split("%")[0]!;
  const tail = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (tail) {
    const octets = ipv4Octets(tail[1]!);
    if (!octets) return null;
    text = text.slice(0, text.length - tail[1]!.length) + ((octets[0]! << 8) | octets[1]!).toString(16) + ":" + ((octets[2]! << 8) | octets[3]!).toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest].map((group) => parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

/** True when the IPv4 address held in two 16-bit groups is a refused one. */
function embeddedIpv4Private(high: number, low: number): boolean {
  return isPrivateIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
}

/** True when an IP address is loopback, private, link-local, shared, reserved or multicast (IPv4 and IPv6). An unreadable address counts as private. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const octets = ipv4Octets(address);
    return !octets || isPrivateIpv4(octets);
  }
  if (version !== 6) return true;
  const groups = ipv6Groups(address);
  if (!groups) return true;
  const allZeroBefore = groups.slice(0, 5).every((group) => group === 0);
  if (groups.every((group) => group === 0)) return true; // ::
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true; // ::1
  if (groups.slice(0, 6).every((group) => group === 0)) return true; // ::/96 IPv4-compatible, such as ::a9fe:a9fe
  if (allZeroBefore && groups[5] === 0xffff) return embeddedIpv4Private(groups[6]!, groups[7]!); // ::ffff:a.b.c.d
  if (groups[0] === 0x64 && groups[1] === 0xff9b) return embeddedIpv4Private(groups[6]!, groups[7]!); // NAT64 64:ff9b::/96
  if ((groups[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((groups[0]! & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if (groups[0] === 0x2002) return embeddedIpv4Private(groups[1]!, groups[2]!); // 2002::/16 6to4: the IPv4 address sits in bits 16..48
  if (groups[0] === 0x2001 && groups[1] === 0) return true; // 2001::/32 Teredo
  if (groups[0] === 0x100 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0) return true; // 100::/64 discard-only
  if ((groups[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((groups[0]! & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/**
 * Checks a webhook URL before it is saved and again before each send. The URL must be HTTPS without credentials, and the
 * host must resolve only to public addresses unless the operator allowed private networks (then http is allowed too).
 * Returns the normalised URL, or throws a 400 ActionError with a plain-language reason.
 */
export async function checkWebhookUrl(raw: string, options: { allowPrivate: boolean; lookup?: AddressLookup }): Promise<string> {
  const { url, hostname } = parseWebhookUrl(raw, options.allowPrivate);
  if (options.allowPrivate || isIP(hostname)) return url;
  await checkResolvedAddresses(hostname, options.lookup);
  return url;
}

/** Syntax and literal-address rules only; no lookup. Throws a 400 ActionError with a plain-language reason. */
function parseWebhookUrl(raw: string, allowPrivate: boolean): { url: string; hostname: string } {
  const refuse = (reason: string): never => { throw new ActionError(reason, 400); };
  if (raw.length > maxUrlLength) refuse("The web address is too long");
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return refuse("Enter a full web address, starting with https://"); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && allowPrivate)) return refuse("The web address must start with https://");
  if (url.username || url.password) return refuse("Remove the user name and password from the web address; use the secret instead");
  const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (!hostname) return refuse("Enter a full web address, starting with https://");
  if (allowPrivate) return { url: url.toString(), hostname };
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!allowedWebhookPorts().includes(port)) return refuse("The web address must use port 443 (or 80 or 8443). Ask your operator if another port is needed");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return refuse("Addresses on this computer or private networks are refused");
  if (isIP(hostname) && isPrivateAddress(hostname)) return refuse("Addresses on this computer or private networks are refused");
  return { url: url.toString(), hostname };
}

/** Looks the name up once and refuses it when any answer is private, loopback, link-local or metadata. */
async function checkResolvedAddresses(hostname: string, lookup?: AddressLookup): Promise<string[]> {
  const refuse = (reason: string): never => { throw new ActionError(reason, 400); };
  let addresses: string[];
  try { addresses = await (lookup ?? resolveAddresses)(hostname); } catch (error) { throw lookupFailure(error); }
  if (addresses.length === 0) return refuse("The web address could not be looked up");
  if (addresses.some(isPrivateAddress)) return refuse("This web address points to a private or local network, which is refused");
  return addresses;
}

export type WebhookTarget = { url: string; hostname: string; address: string; family: 4 | 6 };

/**
 * Resolves a webhook host at delivery time and picks the address the request will connect to. Every address the name
 * resolves to must be public (unless the operator allows private networks); one private address refuses the whole
 * host, so a name that answers with a public and a private address (DNS rebinding) is refused. The caller connects to
 * the returned address and keeps the host name for Host and SNI, so the address checked is the address used.
 */
export async function resolveWebhookTarget(raw: string, options: { allowPrivate: boolean; lookup?: AddressLookup }): Promise<WebhookTarget> {
  const { url, hostname } = parseWebhookUrl(raw, options.allowPrivate);
  if (isIP(hostname)) return { url, hostname, address: hostname, family: isIP(hostname) === 6 ? 6 : 4 };
  const addresses = options.allowPrivate
    ? await (async () => { try { return await (options.lookup ?? resolveAddresses)(hostname); } catch (error) { throw lookupFailure(error); } })()
    : await checkResolvedAddresses(hostname, options.lookup);
  if (addresses.length === 0) throw new ActionError("The web address could not be looked up", 400);
  const address = addresses[0]!;
  return { url, hostname, address, family: isIP(address) === 6 ? 6 : 4 };
}
