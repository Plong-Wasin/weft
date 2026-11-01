import { describe, expect, test } from "bun:test";
import { isWeakSecret, requireProductionSecret } from "../src/secrets";

describe("production secrets", () => {
  test("development falls back to the default without complaint", () => {
    expect(requireProductionSecret("BETTER_AUTH_SECRET", undefined, "dev-default", { env: { NODE_ENV: "development" } })).toBe("dev-default");
    expect(requireProductionSecret("S3_SECRET_KEY", "weft-secret", "x", { env: {} })).toBe("weft-secret");
  });

  test("production refuses unset, default, placeholder, and short values and names the variable", () => {
    const env = { NODE_ENV: "production" };
    for (const value of [undefined, "", "weft", "weft-secret", "change-me-database-password", "development-secret-change-before-deploy-32-chars"]) {
      expect(() => requireProductionSecret("POSTGRES_PASSWORD", value, "weft", { env })).toThrow("POSTGRES_PASSWORD");
    }
    expect(() => requireProductionSecret("BETTER_AUTH_SECRET", "short", "x", { env, minLength: 32 })).toThrow("BETTER_AUTH_SECRET");
  });

  test("production accepts a strong value", () => {
    const strong = "a".repeat(8) + "9f3c2b7d5e1a4c68";
    expect(requireProductionSecret("S3_SECRET_KEY", strong, "weft-secret", { env: { NODE_ENV: "production" } })).toBe(strong);
    expect(isWeakSecret(strong, 16)).toBe(false);
  });
});
