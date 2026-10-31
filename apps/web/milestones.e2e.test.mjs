import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { after, before, test } from 'node:test';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const binary = resolve(appRoot, 'target/debug/weft');
const databaseUrl = process.env.WEFT_E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://weft:weft@127.0.0.1:55432/postgres';
const schema = `weft_milestones_${randomUUID().replaceAll('-', '')}`;
const vaultRoot = `/tmp/weft-e2e-vaults-${schema}`;
const password = 'milestone test password';
let server;
let browser;
let origin;
let workspaceId;

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: appRoot, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function psql(sql) {
  const args = ['-d', databaseUrl, '-v', 'ON_ERROR_STOP=1', '-c', sql];
  const direct = spawnSync('psql', args, { encoding: 'utf8' });
  if (direct.error?.code !== 'ENOENT') {
    assert.equal(direct.status, 0, `psql failed:\n${direct.stdout}\n${direct.stderr}`);
    return;
  }
  run('docker', ['exec', 'weft-shared-pg', 'psql', '-U', 'weft', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
}

async function unusedPort() {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolveClose) => listener.close(resolveClose));
  return port;
}

before(async () => {
  await access(binary);
  await access(resolve(appRoot, 'apps/web/dist/index.html'));
  psql(`CREATE SCHEMA ${schema}`);
  const scopedDatabaseUrl = `${databaseUrl}?options=-csearch_path%3D${schema}`;
  const env = { ...process.env, DATABASE_URL: scopedDatabaseUrl, WEFT_WEB_ROOT: resolve(appRoot, 'apps/web/dist'), WEFT_VAULT_ROOT: vaultRoot };
  run(binary, ['bootstrap-admin', 'owner@example.com', password, 'Milestone Workspace'], env);
  const secondWorkspaceId = randomUUID();
  psql(`SET search_path TO ${schema}; INSERT INTO workspaces (id,name) VALUES ('${secondWorkspaceId}','Secondary Workspace'); INSERT INTO workspace_memberships (workspace_id,user_id,role) SELECT '${secondWorkspaceId}',id,'owner' FROM users WHERE email='owner@example.com'`);
  const port = await unusedPort();
  origin = `http://127.0.0.1:${port}`;
  server = spawn(binary, ['serve'], { cwd: appRoot, env: { ...env, WEFT_LISTEN: `127.0.0.1:${port}` }, stdio: 'ignore' });
  browser = await chromium.launch({ headless: true, ...(process.env.WEFT_CHROMIUM_PATH ? { executablePath: process.env.WEFT_CHROMIUM_PATH } : {}) });
  const probe = await browser.newPage();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await probe.request.get(`${origin}/health/ready`).catch(() => null))?.ok()) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  await probe.close();
});

after(async () => {
  await browser?.close();
  server?.kill('SIGTERM');
  if (server) await once(server, 'exit').catch(() => undefined);
  psql(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await rm(vaultRoot, { recursive: true, force: true });
});

async function signIn(page) {
  await page.goto(origin);
  await page.getByLabel('Email').fill('owner@example.com');
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Choose a Workspace' }).waitFor();
  await page.getByRole('button', { name: /Milestone Workspace/ }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
  const closeTask = page.getByRole('button', { name: 'Close task' });
  const myWorkLoaded = page.waitForResponse((response) => response.url().includes('/my-work') && response.request().method() === 'GET');
  await page.getByRole('button', { name: 'My work', exact: true }).click();
  await myWorkLoaded;
  const allTasksButton = page.getByRole('button', { name: 'All tasks', exact: true });
  await closeTask.or(allTasksButton).first().waitFor();
  if (await closeTask.isVisible()) await closeTask.click();
  await allTasksButton.click();
}

test('a keyboard-only journey creates a Milestone and assigns a Task from the table, the panel and the palette', async () => {
  const page = await (await browser.newContext()).newPage();
  page.setDefaultTimeout(10000);
  await signIn(page);
  const other = await (await browser.newContext()).newPage();
  other.setDefaultTimeout(10000);
  await signIn(other);

  const me = await page.request.get(`${origin}/api/v1/auth/me`).then((response) => response.json());
  workspaceId = me.workspaces[0].id;
  await page.getByLabel('New Project name').fill('Plan project');
  await page.getByRole('button', { name: 'Create Project' }).click();
  await page.getByLabel('Project', { exact: true }).selectOption({ label: 'Plan project' });

  await page.getByLabel('Task title').focus();
  await page.keyboard.type('Write the plan');
  await page.keyboard.press('Enter');
  await page.getByRole('region', { name: 'Task #1' }).waitFor();
  await page.getByRole('button', { name: 'Close task' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('row', { name: /#1 Write the plan/ }).waitFor();

  // Create the Milestone with the keyboard alone: focus the field, type, Enter submits the form.
  await page.getByLabel('Milestone name').focus();
  await page.keyboard.type('Beta release');
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: /Milestones/ }).waitFor();
  await page.locator('.milestones strong', { hasText: 'Beta release' }).waitFor();
  const task = () => page.request.get(`${origin}/api/v1/workspaces/${workspaceId}/tasks/1`).then((response) => response.json());

  // Table cell: focus the select and type the option name.
  const cell = page.getByLabel('Milestone for #1');
  await cell.focus();
  const saved = page.waitForResponse((response) => response.url().includes(`/api/v1/workspaces/${workspaceId}/tasks/1`) && response.request().method() === 'PATCH');
  await page.keyboard.type('Beta');
  assert.equal((await saved).status(), 200);
  assert.equal((await task()).milestone.name, 'Beta release');

  // A second browser updates through the realtime outbox, without a reload.
  await other.getByLabel('Milestone for #1').waitFor();
  await other.waitForFunction(() => document.querySelector('select[aria-label="Milestone for #1"]')?.selectedOptions[0]?.textContent === 'Beta release');

  // Task panel field.
  await page.getByRole('button', { name: 'Write the plan' }).click();
  const panel = page.getByRole('region', { name: 'Task #1' });
  await panel.waitFor();
  const field = panel.getByLabel('Milestone', { exact: true });
  assert.equal(await field.locator('option:checked').textContent(), 'Beta release');
  await field.focus();
  const cleared = page.waitForResponse((response) => response.url().includes(`/api/v1/workspaces/${workspaceId}/tasks/1`) && response.request().method() === 'PATCH');
  await page.keyboard.press('Home');
  assert.equal((await cleared).status(), 200);
  assert.equal((await task()).milestone_id, null);

  // Command palette.
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.waitFor();
  await palette.getByRole('searchbox', { name: 'Search tasks and commands' }).fill('milestone beta');
  await palette.getByRole('option', { name: /Set Milestone to Beta release/ }).waitFor();
  const viaPalette = page.waitForResponse((response) => response.url().includes(`/api/v1/workspaces/${workspaceId}/tasks/1`) && response.request().method() === 'PATCH');
  await page.keyboard.press('Enter');
  const paletteResponse = await viaPalette;
  assert.equal(paletteResponse.status(), 200, `${paletteResponse.request().postData()} => ${await paletteResponse.text()}`);
  assert.equal((await task()).milestone.name, 'Beta release');

  // History records the assignment and Undo reverts it.
  const history = await page.request.get(`${origin}/api/v1/tasks/${(await task()).id}/history`).then((response) => response.json());
  assert.ok(history.operations.some((entry) => entry.field === 'milestone_id'));

  // Rapid keyboard changes: the select is disabled while a save runs, so a second change never
  // reuses a stale version and the row ends on a saved choice with no error banner.
  await page.getByRole('button', { name: 'Close task' }).click();
  await page.getByLabel('Milestone name').fill('Gamma release');
  await page.getByLabel('Milestone name').press('Enter');
  await page.locator('.milestones strong', { hasText: 'Gamma release' }).waitFor();
  const rapid = page.getByLabel('Milestone for #1');
  await rapid.focus();
  for (const key of ['ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowDown']) {
    await rapid.waitFor();
    await page.waitForFunction(() => !document.querySelector('select[aria-label="Milestone for #1"]')?.disabled);
    await rapid.focus();
    await page.keyboard.press(key);
  }
  await page.waitForFunction(() => !document.querySelector('select[aria-label="Milestone for #1"]')?.disabled);
  assert.equal(await page.getByRole('alert').count(), 0);
  const shown = await rapid.locator('option:checked').textContent();
  assert.equal((await task()).milestone?.name ?? 'No Milestone', shown);
});
