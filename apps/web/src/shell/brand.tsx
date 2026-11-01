import React from "react";
import { translate } from "@weft/shared";

/** The Weft mark with "weft" as live text, in the theme's text colour (same pattern as Plane's logo and name). */
export function Brand({ className = "" }: { className?: string }) {
  return <span className={`flex items-center gap-2 ${className}`}>
    <img src="/brand/weft-mark.png" alt="" width={24} height={24} className="size-6 object-contain" />
    <span className="text-16 font-semibold text-primary">{translate("app.title").toLowerCase()}</span>
  </span>;
}
