import type { MessageKey } from "@weft/shared";
import { translate } from "@weft/shared";

/** A route that exists at its Plane URL before its screen is built. */
export function PlaceholderPage({ heading }: { heading: MessageKey }) {
  return <section><h3 className="text-18 font-semibold">{translate(heading)}</h3><p role="status" className="text-secondary">{translate("route.comingSoon")}</p></section>;
}
