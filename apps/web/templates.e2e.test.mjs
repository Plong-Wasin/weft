import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { after, before, test } from 'node:test';
import { access, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Templates in a real browser: a member creates a Task from a template and undoes it with the
// keyboard only.

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const binary = resolve(appRoot, 'target/debug/weft');
const databaseUrl = process.env.WEFT_E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://weft:weft@127.0.0.1:55432/postgres';
const schema = `weft_templates_${randomUUID().replaceAll('-', '')}`;
const vaultRoot = `/tmp/weft-e2e-templates-vaults-${schema}`;
const ownerPassword = 'owner templates password';
const memberPassword = 'member templates password';
const ownerEmail = 'owner@example.com';
const memberEmail = 'member@example.com';
let server;
let browser;
let origin;
let workspaceId;
let projectId;
let api;

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

const csrfOf = async (page) => (await page.context().cookies(origin)).find((cookie) => cookie.name === 'weft_csrf')?.value;

async function signIn(page, email, password) {
  await page.goto(origin);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const picker = page.getByRole('heading', { name: 'Choose a Workspace' });
  const tasks = page.getByRole('heading', { name: 'Tasks', exact: true });
  await picker.or(tasks).waitFor();
  if (await picker.isVisible()) {
    await page.getByRole('button', { name: /Templates Workspace/ }).focus();
    await page.keyboard.press('Enter');
    await tasks.waitFor();
  }
}

async function createTask(data) {
  const response = await api.request.post(`${origin}/api/v1/workspaces/${workspaceId}/tasks`, { data: { project_id: projectId, ...data }, headers: { 'x-csrf-token': await csrfOf(api) } });
  assert.equal(response.status(), 201, await response.text());
  return response.json();
}

async function openTask(page, task) {
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.waitFor();
  await palette.getByRole('searchbox', { name: 'Search tasks and commands' }).fill(task.title);
  await palette.getByRole('option', { name: new RegExp(task.title) }).first().waitFor();
  await page.keyboard.press('Enter');
  await page.getByRole('region', { name: `Task #${task.number}` }).waitFor();
}

const waitForRequest = (page, part, method) => page.waitForResponse((response) => response.url().includes(part) && response.request().method() === method);

async function pressUndo(page) {
  const response = waitForRequest(page, `/workspaces/${workspaceId}/history/undo`, 'POST');
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await page.keyboard.press('Control+z');
  return response;
}

before(async () => {
  await access(binary);
  await access(resolve(appRoot, 'apps/web/dist/index.html'));
  psql(`CREATE SCHEMA ${schema}`);
  const scopedDatabaseUrl = `${databaseUrl}?options=-csearch_path%3D${schema}`;
  const env = { ...process.env, DATABASE_URL: scopedDatabaseUrl, WEFT_WEB_ROOT: resolve(appRoot, 'apps/web/dist'), WEFT_VAULT_ROOT: vaultRoot };
  run(binary, ['bootstrap-admin', ownerEmail, ownerPassword, 'Templates Workspace'], env);
  const port = await unusedPort();
  origin = `http://127.0.0.1:${port}`;
  server = spawn(binary, ['serve'], { cwd: appRoot, env: { ...env, WEFT_LISTEN: `127.0.0.1:${port}` }, stdio: 'ignore' });
  browser = await chromium.launch({ headless: true, ...(process.env.WEFT_CHROMIUM_PATH ? { executablePath: process.env.WEFT_CHROMIUM_PATH } : {}) });
  api = await browser.newPage();
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await api.request.get(`${origin}/health/ready`).catch(() => null))?.ok()) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  // Owner session through the real sign-in API, then a Project and a second member by invite.
  const signedIn = await api.request.post(`${origin}/api/v1/auth/sign-in`, { data: { email: ownerEmail, password: ownerPassword } });
  assert.equal(signedIn.status(), 200, await signedIn.text());
  const me = await api.request.get(`${origin}/api/v1/auth/me`).then((response) => response.json());
  workspaceId = me.workspaces.find((item) => item.name === 'Templates Workspace').id;
  const csrf = await csrfOf(api);
  const project = await api.request.post(`${origin}/api/v1/workspaces/${workspaceId}/projects`, { data: { name: 'Templates project', visibility: 'workspace' }, headers: { 'x-csrf-token': csrf } });
  assert.equal(project.status(), 201, await project.text());
  projectId = (await project.json()).id;
  const invite = await api.request.post(`${origin}/api/v1/auth/invites`, { data: { role: 'member', expires_in_hours: 24 }, headers: { 'x-csrf-token': csrf } }).then((response) => response.json());
  const fresh = await browser.newPage();
  const accepted = await fresh.request.post(`${origin}/api/v1/auth/invites/accept`, { data: { token: invite.token, email: memberEmail, password: memberPassword } });
  assert.equal(accepted.status(), 201, await accepted.text());
  await fresh.close();
  psql(`SET search_path TO ${schema}; INSERT INTO project_memberships(workspace_id,project_id,user_id,role) SELECT '${workspaceId}','${projectId}',id,'contributor' FROM users WHERE email='${memberEmail}'`);
});

after(async () => {
  await browser?.close();
  server?.kill('SIGTERM');
  if (server) await once(server, 'exit').catch(() => undefined);
  psql(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await rm(vaultRoot, { recursive: true, force: true });
});


const tabTo = async (page, name) => {
  for (let step = 0; step < 40; step += 1) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => document.activeElement?.labels?.[0]?.firstChild?.textContent?.trim() || document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent?.trim() || '');
    if (focused === name) return;
  }
  assert.fail(`could not reach ${name} by keyboard`);
};

test('a member creates a Task from a template and undoes it with the keyboard only', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  try {
    const csrf = await csrfOf(api);
    const template = await api.request.post(`${origin}/api/v1/workspaces/${workspaceId}/task-templates`, {
      data: { name: 'Release', title_pattern: 'Release {{version}}', checklist: ['Tag'], subtasks: [{ title_pattern: 'Freeze {{version}}' }] },
      headers: { 'x-csrf-token': csrf },
    });
    assert.equal(template.status(), 201, await template.text());
    const titles = async () => (await api.request.get(`${origin}/api/v1/workspaces/${workspaceId}/tasks`).then((response) => response.json())).tasks.map((task) => task.title);
    await signIn(page, memberEmail, memberPassword);

    // Palette command, then everything by keys.
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await palette.waitFor();
    await palette.getByRole('searchbox', { name: 'Search tasks and commands' }).fill('template');
    await palette.getByRole('option', { name: /Create from a template/ }).waitFor();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Templates' });
    await dialog.waitFor();
    await dialog.getByRole('combobox', { name: /^Template/ }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'SELECT', 'focus lands on the template chooser');
    await page.keyboard.press('ArrowDown');
    await tabTo(page, 'Project');
    await tabTo(page, 'version');
    await page.keyboard.type('2.0');
    const created = waitForRequest(page, '/instantiate', 'POST');
    await page.keyboard.press('Enter');
    assert.equal((await created).status(), 201);
    await dialog.getByRole('status').filter({ hasText: 'Created 2 tasks' }).waitFor();
    assert.deepEqual((await titles()).filter((title) => /2\.0/.test(title)).sort(), ['Freeze 2.0', 'Release 2.0']);

    // Undo the whole group from the dialog by keyboard.
    const undone = waitForRequest(page, '/history/undo', 'POST');
    await page.getByRole('button', { name: 'Undo creation' }).focus();
    await page.keyboard.press('Enter');
    assert.equal((await undone).status(), 200);
    await dialog.getByRole('status').filter({ hasText: 'Undone' }).waitFor();
    assert.deepEqual((await titles()).filter((title) => /2\.0/.test(title)), []);

    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
  } finally {
    await context.close();
  }
});
