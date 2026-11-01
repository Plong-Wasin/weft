/** Placeholder and development defaults that must never reach a production instance. */
const weakValues = new Set(["weft", "weft-secret", "development-secret-change-before-deploy-32-chars"]);

export const isProduction = (env: Record<string, string | undefined> = Bun.env) => env.NODE_ENV === "production";

/** True for unset, empty, known-default, or "change-me" placeholder values. */
export function isWeakSecret(value: string | undefined, minLength = 1) {
  if (!value || value.length < minLength) return true;
  return weakValues.has(value) || value.toLowerCase().includes("change-me");
}

/**
 * Returns `value`, or the development fallback outside production. In production a weak or missing
 * value stops the process with a message that names the variable.
 */
export function requireProductionSecret(name: string, value: string | undefined, fallback: string, options: { minLength?: number; env?: Record<string, string | undefined> } = {}) {
  if (isProduction(options.env) && isWeakSecret(value, options.minLength)) {
    throw new Error(`${name} is unset or still a default or placeholder value. Set a strong random value (for example \`openssl rand -hex 32\`) before running in production.`);
  }
  return value ?? fallback;
}
