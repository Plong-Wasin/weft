import React from "react";
import { translate } from "@weft/shared";
import { api } from "../api";
import { AuthShell, primaryButton } from "../layouts/auth-shell";

type RequestInfo = { hostname: string; account: { name: string; email: string }; access: string; expiresAt: string };

export function CliDeviceApprovalPage() {
  const code = React.useMemo(() => new URLSearchParams(window.location.search).get("code") ?? "", []);
  const [info, setInfo] = React.useState<RequestInfo | null>(null);
  const [message, setMessage] = React.useState("");
  const [error, setError] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    let referrer = document.querySelector<HTMLMetaElement>('meta[name="referrer"]');
    if (!referrer) { referrer = document.createElement("meta"); referrer.name = "referrer"; document.head.append(referrer); }
    referrer.content = "no-referrer";
    let active = true;
    fetch(`${api}/api/cli/device-authorization?code=${encodeURIComponent(code)}`, { credentials: "include", cache: "no-store" })
      .then(async (response) => {
        const data = await response.json().catch(() => null) as (RequestInfo & { error?: string }) | null;
        if (!response.ok || !data) throw new Error(data?.error ?? "This sign-in request is invalid or expired.");
        return data;
      })
      .then((data) => { if (active) setInfo(data); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : translate("cliDevice.loadFailed")); });
    return () => { active = false; };
  }, [code]);

  async function decide(decision: "approve" | "deny") {
    setSubmitting(true); setError("");
    try {
      const response = await fetch(`${api}/api/cli/device-authorization/decision`, {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, decision }),
      });
      const result = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(result?.error ?? translate("cliDevice.decisionFailed"));
      setMessage(translate(decision === "approve" ? "cliDevice.approved" : "cliDevice.denied"));
      setInfo(null);
      window.history.replaceState({}, "", window.location.pathname);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not complete this decision.");
    } finally { setSubmitting(false); }
  }

  return <AuthShell>
      <h1 className="text-20 font-semibold">{translate("cliDevice.title")}</h1>
    {message && <p role="status" className="mt-4 text-14 text-secondary">{message}</p>}
    {error && <p role="alert" className="mt-4 text-14 text-danger-text">{error}</p>}
    {!info && !message && !error && <p role="status" className="mt-4 text-14 text-secondary">{translate("cliDevice.loading")}</p>}
    {info && <>
      <p className="mt-4 text-14 text-secondary">{translate("cliDevice.request")}</p>
      <dl className="mt-5 grid gap-3 rounded-lg border border-subtle p-4 text-14">
        <div><dt className="text-secondary">{translate("cliDevice.code")}</dt><dd className="mt-1 font-mono font-semibold tracking-[0.2em] text-primary">{code.slice(0, 4)} {code.slice(4)}</dd></div>
        <div><dt className="text-secondary">{translate("cliDevice.machine")}</dt><dd className="mt-1 break-all font-medium text-primary">{info.hostname}</dd></div>
        <div><dt className="text-secondary">{translate("cliDevice.account")}</dt><dd className="mt-1 font-medium text-primary"><span className="block">{info.account.name}</span><span className="block break-all">{info.account.email}</span></dd></div>
        <div><dt className="text-secondary">{translate("cliDevice.accessLabel")}</dt><dd className="mt-1 font-medium text-primary">{translate("cliDevice.access")}</dd></div>
      </dl>
      <p className="mt-4 text-14 text-secondary">{translate("cliDevice.warning")}</p>
      <div className="mt-6 grid gap-3">
        <button className={primaryButton} disabled={submitting} onClick={() => void decide("approve")}>{translate("cliDevice.approve")}</button>
        <button type="button" className="!h-10 rounded-md border border-subtle bg-transparent px-3 text-14 font-medium text-primary hover:bg-layer-1-hover focus-visible:outline focus-visible:outline-2" disabled={submitting} onClick={() => void decide("deny")}>{translate("cliDevice.deny")}</button>
      </div>
    </>}
  </AuthShell>;
}
