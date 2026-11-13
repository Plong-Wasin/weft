import { Type } from "@sinclair/typebox";
import type { projects } from "@weft/db";
import { ActionError } from "./members";

/** Per-project feature switches. A new switchable feature is added here and as a column on `projects`. */
export const projectFeatures = ["cycles", "modules", "intake", "pages", "views", "types"] as const;
export type ProjectFeature = (typeof projectFeatures)[number];
export type ProjectFeatures = Record<ProjectFeature, boolean>;
type ProjectRow = typeof projects.$inferSelect;

/** Column of `projects` that stores each switch. */
export const featureColumns = {
  cycles: "cyclesEnabled", modules: "modulesEnabled", intake: "intakeEnabled", pages: "pagesEnabled", views: "viewsEnabled", types: "typesEnabled",
} as const satisfies Record<ProjectFeature, keyof ProjectRow>;

/** Names as people see them in the UI and in messages to Agents, the CLI and MCP. */
export const featureLabels: Record<ProjectFeature, string> = { cycles: "Cycles", modules: "Modules", intake: "Intake", pages: "Pages", views: "Views", types: "Work item types" };

/** A new project starts in the Simple shape (Cycles, Modules and Intake off; Pages and Views stay on) or the Full shape (every switch on). */
export const projectShapes = ["simple", "full"] as const;
export type ProjectShape = (typeof projectShapes)[number];
export const simpleShapeFeatures: ProjectFeatures = { cycles: false, modules: false, intake: false, pages: true, views: true, types: false };
export const fullShapeFeatures: ProjectFeatures = { cycles: true, modules: true, intake: true, pages: true, views: true, types: false };
export function featuresForShape(shape: ProjectShape): ProjectFeatures {
  return shape === "simple" ? { ...simpleShapeFeatures } : { ...fullShapeFeatures };
}

export const featuresSchema = Type.Object({ cycles: Type.Boolean(), modules: Type.Boolean(), intake: Type.Boolean(), pages: Type.Boolean(), views: Type.Boolean(), types: Type.Boolean() });
export const featuresPatchSchema = Type.Object({ cycles: Type.Optional(Type.Boolean()), modules: Type.Optional(Type.Boolean()), intake: Type.Optional(Type.Boolean()), pages: Type.Optional(Type.Boolean()), views: Type.Optional(Type.Boolean()), types: Type.Optional(Type.Boolean()) });

export function featuresOf(project: ProjectRow): ProjectFeatures {
  return Object.fromEntries(projectFeatures.map((feature) => [feature, project[featureColumns[feature]]])) as ProjectFeatures;
}

/** The message an Agent, the CLI, MCP or the API gets for a switched-off feature: what is off, and who can turn it on. */
export function featureOffMessage(feature: ProjectFeature) {
  return `The ${featureLabels[feature]} feature is turned off in this project. A project admin or workspace admin can turn it on in Project settings > Features.`;
}

/** Call after the project permission check: an Action of a turned-off feature is rejected (400) and its data is kept. */
export function assertFeatureEnabled(project: ProjectRow, feature: ProjectFeature) {
  if (!project[featureColumns[feature]]) throw new ActionError(featureOffMessage(feature), 400);
}
