import { Type } from "@sinclair/typebox";
import type { projects } from "@weft/db";
import { ActionError } from "./members";

/** Per-project feature toggles. A new toggleable feature is added here and as a column on `projects`. */
export const projectFeatures = ["cycles", "modules", "intake"] as const;
export type ProjectFeature = (typeof projectFeatures)[number];
export type ProjectFeatures = Record<ProjectFeature, boolean>;
type ProjectRow = typeof projects.$inferSelect;

/** Column of `projects` that stores each toggle. */
export const featureColumns = { cycles: "cyclesEnabled", modules: "modulesEnabled", intake: "intakeEnabled" } as const satisfies Record<ProjectFeature, keyof ProjectRow>;

const featureLabels: Record<ProjectFeature, string> = { cycles: "Cycles", modules: "Modules", intake: "Intake" };

export const featuresSchema = Type.Object({ cycles: Type.Boolean(), modules: Type.Boolean(), intake: Type.Boolean() });
export const featuresPatchSchema = Type.Object({ cycles: Type.Optional(Type.Boolean()), modules: Type.Optional(Type.Boolean()), intake: Type.Optional(Type.Boolean()) });

export function featuresOf(project: ProjectRow): ProjectFeatures {
  return Object.fromEntries(projectFeatures.map((feature) => [feature, project[featureColumns[feature]]])) as ProjectFeatures;
}

/** Call after the project permission check: an Action of a turned-off feature is rejected (400) and its data is kept. */
export function assertFeatureEnabled(project: ProjectRow, feature: ProjectFeature) {
  if (!project[featureColumns[feature]]) throw new ActionError(`${featureLabels[feature]} are turned off for this project`, 400);
}
