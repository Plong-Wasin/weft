import React from "react";
import { translate } from "@weft/shared";
import { authClient } from "../auth-client";
import { api } from "../api";
import { AuthShell, primaryButton } from "../layouts/auth-shell";

type ConsentInfo = { clientName: string; redirectHost: string };

export function OAuthConsentPage() {
  const [info, setInfo] = React.useState<ConsentInfo | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    fetch(`${api}/api/oauth/consent-info${window.location.search}`, { credentials: "include" })
      .then(async (response) => {
        if (!response.ok) throw new Error(translate("oauth.failed"));
        return await response.json() as ConsentInfo;
      })
      .then((value) => { if (active) setInfo(value); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : translate("oauth.failed")); });
    return () => { active = false; };
  }, []);

  async function respond(accept: boolean) {
    setSubmitting(true); setError(null);
    const result = await authClient.oauth2.consent({ accept });
    if (result.error) { setError(translate("oauth.failed")); setSubmitting(false); return; }
    window.location.assign(result.data.url);
  }

  return <AuthShell>
    <h1 className="text-20 font-semibold">{translate("oauth.title")}</h1>
    {error ? <p role="alert" className="mt-4 text-14 text-danger-text">{error}</p> : !info ? <p role="status" className="mt-4 text-14 text-secondary">{translate("oauth.loading")}</p> : <>
      <p className="mt-4 text-14 text-secondary">{translate("oauth.request").replace("{app}", info.clientName).replace("{host}", info.redirectHost)}</p>
      <div className="mt-6 grid gap-3">
        <button className={primaryButton} disabled={submitting} onClick={() => void respond(true)}>{translate("oauth.allow")}</button>
        <button type="button" className="!h-10 rounded-md border border-subtle bg-transparent px-3 text-14 font-medium text-primary hover:bg-layer-1-hover" disabled={submitting} onClick={() => void respond(false)}>{translate("oauth.deny")}</button>
      </div>
    </>}
  </AuthShell>;
}
