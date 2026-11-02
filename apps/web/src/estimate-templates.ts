/** Ready-made scales for a points Estimate. They only fill the form: the stored Estimate is plain points. */
export const estimateTemplates = {
  fibonacci: ["1", "2", "3", "5", "8", "13"],
  linear: ["1", "2", "3", "4", "5", "6"],
  squares: ["1", "4", "9", "16", "25", "36"],
  custom: ["1", "2"],
} as const;
export type EstimateTemplate = keyof typeof estimateTemplates;
export const estimateTemplateKeys = Object.keys(estimateTemplates) as EstimateTemplate[];
export const categoryStarter = ["S", "M", "L"];
export const estimateLimits = { min: 2, max: 6 } as const;
