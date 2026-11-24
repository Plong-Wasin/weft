import React from "react";
import { Link } from "react-router";
import { translate } from "@weft/shared";

/** The screen for a URL no route matches: a heading, one line on why, and one way back. `to` is omitted when no safe place to return to is known. */
export function NotFound({ to, label }: { to?: string; label?: string }) {
  return <section role="alert" className="mx-auto grid max-w-md justify-items-center gap-2 px-4 py-16 text-center">
    <h1 className="m-0 text-20 font-semibold text-primary">{translate("app.notFound")}</h1>
    <p className="m-0 text-14 text-secondary">{translate("app.notFoundHint")}</p>
    {to && <Link to={to} className="mt-3 inline-flex h-9 items-center rounded-md border border-strong px-4 text-14 font-medium text-primary hover:bg-layer-transparent-hover">{label}</Link>}
  </section>;
}
