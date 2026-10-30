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
const schema = `weft_recurrence_${randomUUID().replaceAll('-', '')}`;
const vaultRoot = `/tmp/weft-e2e-vaults-${schema}`;
const password = 'recurrence test password';
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
  run(binary, ['bootstrap-admin', 'owner@example.com', password, 'Recurrence Workspace'], env);
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
  await page.getByRole('button', { name: /Recurrence Workspace/ }).focus();
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

test('a keyboard-only journey sets a weekly rule, completes the Task and sees the next occurrence', async () => {
  const page = await (await browser.newContext()).newPage();
  page.setDefaultTimeout(10000);
  await signIn(page);
  const me = await page.request.get(`${origin}/api/v1/auth/me`).then((response) => response.json());
  workspaceId = me.workspaces[0].id;
  await page.getByLabel('New Project name').fill('Chores');
  await page.getByRole('button', { name: 'Create Project' }).click();
  await page.getByLabel('Project', { exact: true }).selectOption({ label: 'Chores' });

  await page.getByLabel('Task title').focus();
  await page.keyboard.type('Water the plants');
  await page.keyboard.press('Enter');
  const panel = page.getByRole('region', { name: 'Task #1' });
  await panel.waitFor();
  const task = (number) => page.request.get(`${origin}/api/v1/workspaces/${workspaceId}/tasks/${number}`).then((response) => response.json());
  const patched = () => page.waitForResponse((response) => response.url().includes(`/api/v1/workspaces/${workspaceId}/tasks/1`) && response.request().method() === 'PATCH');

  // A due date for the rule to shift: type it, then Enter in the title field saves the form.
  await panel.getByLabel('Due date').fill('2030-03-04');
  await panel.getByLabel('Title', { exact: true }).focus();
  let saved = patched();
  await page.keyboard.press('Enter');
  assert.equal((await saved).status(), 200);

  // Set the rule with the keyboard alone: pick Weekly, tick Monday, press Save repeat.
  await panel.getByLabel('Repeat frequency').focus();
  await page.keyboard.type('Weekly');
  await panel.getByLabel('Monday').focus();
  await page.keyboard.press('Space');
  const ruleSaved = page.waitForResponse((response) => response.url().includes('/recurrence') && response.request().method() === 'PUT');
  await panel.getByRole('button', { name: 'Save repeat' }).focus();
  await page.keyboard.press('Enter');
  assert.equal((await ruleSaved).status(), 200);
  await panel.getByText('Repeats every Monday').waitFor();
  assert.equal((await task(1)).recurrence.frequency, 'weekly');

  // Complete the Task: the next occurrence appears in the table with its date shifted a week.
  await panel.locator('.form-grid select').first().focus();
  await page.keyboard.type('Completed');
  await panel.getByLabel('Title', { exact: true }).focus();
  saved = patched();
  await page.keyboard.press('Enter');
  assert.equal((await saved).status(), 200);
  await page.getByRole('button', { name: 'Close task' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('row', { name: /#2 Water the plants/ }).waitFor();
  const next = await task(2);
  assert.equal(next.due_date, '2030-03-11');
  assert.equal(next.recurrence.frequency, 'weekly');
  assert.notEqual(next.status, 'completed');

  // Stop repeating from the keyboard: the rule is gone from the open Task.
  await page.getByRole('button', { name: 'Water the plants' }).last().click();
  const second = page.getByRole('region', { name: 'Task #2' });
  await second.waitFor();
  const stopped = page.waitForResponse((response) => response.url().includes('/recurrence') && response.request().method() === 'DELETE');
  await second.getByRole('button', { name: 'Stop repeating' }).focus();
  await page.keyboard.press('Enter');
  assert.equal((await stopped).status(), 200);
  await second.getByRole('status').filter({ hasText: 'Does not repeat' }).waitFor();
  assert.ok(!(await task(2)).recurrence);
});
