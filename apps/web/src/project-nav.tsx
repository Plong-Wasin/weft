import React from "react";
import { translate, type MessageKey } from "@weft/shared";

export const projectFeatureKeys = ["cycles", "modules", "intake"] as const;
export type ProjectFeatureKey = (typeof projectFeatureKeys)[number];
export type ProjectFeatures = Record<ProjectFeatureKey, boolean>;

/** One entry per toggleable feature that has pages: later features add their entry here and nothing else. */
const menu: Array<{ feature: ProjectFeatureKey; path: string; label: MessageKey }> = [
  { feature: "cycles", path: "cycles", label: "cycles.title" },
];

/** Project menu: a turned-off feature has no entry. */
export function ProjectNav({ base, features }: { base: string; features: ProjectFeatures }) {
  return <nav aria-label={translate("projectNav.label")}>{menu.filter((entry) => features[entry.feature]).map((entry) => <a key={entry.path} href={`${base}/${entry.path}`}>{translate(entry.label)} </a>)}</nav>;
}

/** Admin checkboxes for every toggle; `onChange` receives the one feature that flipped. */
export function FeatureToggles({ features, canAdmin, onChange }: { features: ProjectFeatures; canAdmin: boolean; onChange: (feature: ProjectFeatureKey, enabled: boolean) => void }) {
  return <fieldset>
    <legend>{translate("features.title")}</legend>
    {projectFeatureKeys.map((feature) => <label key={feature}>
      <input type="checkbox" disabled={!canAdmin} checked={features[feature]} onChange={(event) => onChange(feature, event.target.checked)} />{translate(`features.${feature}` as MessageKey)}
    </label>)}
  </fieldset>;
}
