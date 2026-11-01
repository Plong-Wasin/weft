// Minimal session client for a local Plane instance, used only to seed reference data.
export class PlaneClient {
  private cookies = new Map<string, string>();
  constructor(readonly base: string) {}

  /** Session cookies for a browser context on the same host. */
  browserCookies() { return [...this.cookies].map(([name, value]) => ({ name, value, url: this.base })); }

  private cookieHeader() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "); }
  private store(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const i = pair.indexOf("=");
      this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  async raw(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("cookie", this.cookieHeader());
    headers.set("referer", `${this.base}/`);
    headers.set("origin", this.base);
    const csrf = this.cookies.get("csrftoken");
    if (csrf) headers.set("x-csrftoken", csrf);
    const res = await fetch(`${this.base}${path}`, { ...init, headers, redirect: "manual" });
    this.store(res);
    return res;
  }

  async json<T = any>(path: string, method = "GET", body?: unknown): Promise<T> {
    const res = await this.raw(path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : (undefined as T);
  }

  /** Sign in (creating the account on first run). Plane's auth endpoints are CSRF-protected form posts. */
  async signIn(email: string, password: string) {
    for (const endpoint of ["/auth/sign-in/", "/auth/sign-up/"]) {
      const csrf = (await (await this.raw("/auth/get-csrf-token/")).json()).csrf_token as string;
      const form = new URLSearchParams({ email, password, csrfmiddlewaretoken: csrf, next_path: "" });
      const res = await this.raw(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
      const location = res.headers.get("location") ?? "";
      if (res.status >= 300 && res.status < 400 && !location.includes("error_code")) return;
    }
    throw new Error("Plane sign-in and sign-up both failed");
  }
}
