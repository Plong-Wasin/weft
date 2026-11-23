import { expect, test } from "bun:test";

// Every environment flag this ticket covers must be documented with its real default in the env example and the README table,
// and passed through by both compose files to the containers. Reads the files as shipped; no database or server is needed.
const root = new URL("../../../", import.meta.url);
const read = (path: string) => Bun.file(new URL(path, root)).text();

type Flag = {
  name: string;
  /** Default as the code treats an unset variable: the value written in the env example and the compose fallback. */
  default: string;
  /** How the README default cell shows it: the default in backticks, or "unset" when there is none. */
  readmeDefault: string;
};

const flags: Flag[] = [
  { name: "WEFT_OUTBOUND_WEBHOOKS_ENABLED", default: "false", readmeDefault: "`false`" },
  { name: "WEFT_OUTBOUND_WEBHOOKS_ALLOW_PRIVATE_NETWORKS", default: "false", readmeDefault: "`false`" },
  { name: "WEFT_OUTBOUND_WEBHOOKS_ALLOW_PORTS", default: "", readmeDefault: "unset" },
  { name: "WEFT_AI_ENABLED", default: "true", readmeDefault: "`true`" },
  { name: "AI_WEB_SEARCH", default: "on", readmeDefault: "`on`" },
  { name: "AI_ASSIST_REQUESTS_PER_MINUTE", default: "20", readmeDefault: "`20`" },
];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("every flag has its default in the env example", async () => {
  const example = await read(".env.example");
  for (const flag of flags) {
    const line = new RegExp(`^${escape(flag.name)}=(.*)$`, "m").exec(example);
    expect(line, `${flag.name} missing from .env.example`).not.toBeNull();
    expect(line![1]!.trim(), `${flag.name} default in .env.example`).toBe(flag.default);
  }
});

test("every flag has a row with its default in the README environment table", async () => {
  const readme = await read("README.md");
  const rows = readme.split("\n").filter((line) => line.startsWith("|"));
  for (const flag of flags) {
    const row = rows.find((line) => line.split("|")[2]?.trim() === `\`${flag.name}\``);
    expect(row, `${flag.name} missing from the README environment table`).toBeDefined();
    expect(row!.split("|")[3]?.trim(), `${flag.name} default in the README`).toBe(flag.readmeDefault);
  }
});

// Bun.YAML resolves the x-app-env anchor, so each service's environment is checked as it is actually passed to the container.
for (const file of ["compose.yaml", "docker-compose.dokploy.yml"]) {
  test(`${file} passes every flag through to the api and worker containers with its default`, async () => {
    const compose = Bun.YAML.parse(await read(file)) as { services: Record<string, { environment?: Record<string, string> }> };
    for (const service of ["api", "worker"]) {
      const environment = compose.services[service]?.environment ?? {};
      for (const flag of flags) {
        expect(environment[flag.name], `${flag.name} in ${file} service ${service}`).toBe(`\${${flag.name}:-${flag.default}}`);
      }
    }
  });
}
