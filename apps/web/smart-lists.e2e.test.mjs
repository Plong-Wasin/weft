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
const schema = `weft_smartlists_${randomUUID().replaceAll('-', '')}`;
const vaultRoot = `/tmp/weft-e2e-smartlists-vaults-${schema}`;
const password = 'smart list test password';
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
  run(binary, ['bootstrap-admin', 'owner@example.com', password, 'Smart Workspace'], env);
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
  await page.getByRole('button', { name: /Smart Workspace/ }).focus();
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


const csrfOf = async (page) => (await page.context().cookies(origin)).find((cookie) => cookie.name === 'weft_csrf')?.value;

// Types into a focused <select> the way a keyboard user picks an option.
async function pick(page, label, option) {
  await page.getByLabel(label, { exact: true }).focus();
  await page.keyboard.type(option);
}

test('a keyboard-only journey builds a nested AND/OR Smart List with relative dates and Milestone state', async () => {
  const page = await (await browser.newContext()).newPage();
  page.setDefaultTimeout(10000);
  await signIn(page);
  const me = await page.request.get(`${origin}/api/v1/auth/me`).then((response) => response.json());
  workspaceId = me.workspaces.find((item) => item.name === 'Smart Workspace').id;
  const headers = { 'x-csrf-token': await csrfOf(page) };
  const post = async (path, data) => {
    const response = await page.request.post(`${origin}/api/v1${path}`, { data, headers });
    assert.ok(response.ok(), `${path}: ${response.status()} ${await response.text()}`);
    return response.json();
  };
  const project = await post(`/workspaces/${workspaceId}/projects`, { name: 'Plan project', visibility: 'workspace' });
  const settings = await page.request.get(`${origin}/api/v1/workspaces/${workspaceId}/settings`).then((response) => response.json());
  const dayOffset = (days) => { const date = new Date(`${settings.today}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); };
  const milestone = await post(`/projects/${project.id}/milestones`, { name: 'Beta', state: 'active' });
  const task = (title, extra) => post(`/workspaces/${workspaceId}/tasks`, { project_id: project.id, title, ...extra });
  await task('Overdue chore', { due_date: dayOffset(-2) });
  await task('Urgent soon', { priority: 'urgent', due_date: dayOffset(1) });
  await task('Normal soon', { priority: 'normal', due_date: dayOffset(1) });
  const inBeta = await task('Beta work', {});
  const patched = await page.request.patch(`${origin}/api/v1/tasks/${inBeta.id}`, { data: { expected_version: inBeta.version, milestone_id: milestone.id }, headers });
  assert.ok(patched.ok(), await patched.text());
  const views = page.getByLabel('Task views');
  const myWork = page.waitForResponse((response) => response.url().includes('/my-work'));
  await views.getByRole('button', { name: 'My work', exact: true }).click();
  await myWork;
  await views.getByRole('button', { name: 'All tasks', exact: true }).click();

  // Open the builder with the keyboard.
  await page.getByText('Advanced Smart List', { exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('Advanced Smart List name').focus();
  await page.keyboard.type('Due soon or in Beta');
  // Top group matches any: (Due date is Overdue) OR (group: Priority is urgent AND Due date is next 7 days).
  await pick(page, 'Top group logic', 'Match any');
  await page.getByRole('button', { name: 'Add condition to Top group' }).focus();
  await page.keyboard.press('Enter');
  await pick(page, 'Condition 1 field', 'Due date');
  await pick(page, 'Condition 1 value', 'Overdue');
  await page.getByRole('button', { name: 'Add group to Top group' }).focus();
  await page.keyboard.press('Enter');
  await pick(page, 'Condition 2.1 field', 'Priority');
  await pick(page, 'Condition 2.1 value', 'urgent');
  await page.getByRole('button', { name: 'Add condition to Group 2' }).focus();
  await page.keyboard.press('Enter');
  await pick(page, 'Condition 2.2 field', 'Due date');
  await pick(page, 'Condition 2.2 value', 'Next 7 days');
  await page.getByRole('button', { name: 'Add condition to Top group' }).focus();
  await page.keyboard.press('Enter');
  await pick(page, 'Condition 3 field', 'Milestone state');
  await pick(page, 'Condition 3 value', 'active');
  await page.getByRole('button', { name: 'Create advanced Smart List' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('status').filter({ hasText: 'Created Smart List Due soon or in Beta' }).waitFor();

  for (const title of ['Overdue chore', 'Urgent soon', 'Beta work']) await page.getByText(title, { exact: true }).first().waitFor();
  assert.equal(await page.getByText('Normal soon', { exact: true }).count(), 0, 'the nested AND group excludes a normal-priority Task');

  // An over-deep query from the same builder is refused with a readable message: nest to the limit.
  await page.getByLabel('Advanced Smart List name').focus();
  await page.keyboard.type('Too deep');
  // Each new group adds one level; keep nesting through the innermost group until the button disables.
  for (let level = 0; level < 6; level += 1) {
    const add = page.getByRole('button', { name: /^Add group to / }).first();
    if (await add.isDisabled()) break;
    await add.focus();
    await page.keyboard.press('Enter');
  }
  const deepest = page.getByRole('button', { name: /^Add group to Group/ });
  assert.ok((await deepest.count()) >= 1);
  assert.equal(await deepest.first().isDisabled(), true, 'the builder stops adding groups at the depth limit');
});

test('the builder keeps focus, refuses an empty value, and a grouped List shows Milestone headings', async () => {
  const page = await (await browser.newContext()).newPage();
  page.setDefaultTimeout(10000);
  await signIn(page);
  const headers = { 'x-csrf-token': await csrfOf(page) };
  const post = async (path, data) => {
    const response = await page.request.post(`${origin}/api/v1${path}`, { data, headers });
    assert.ok(response.ok(), `${path}: ${response.status()} ${await response.text()}`);
    return response.json();
  };
  const project = await post(`/workspaces/${workspaceId}/projects`, { name: 'Group project', visibility: 'workspace' });
  const aardvark = await post(`/projects/${project.id}/milestones`, { name: 'Aardvark', state: 'active' });
  const zebra = await post(`/projects/${project.id}/milestones`, { name: 'Zebra', state: 'active' });
  for (const [title, milestone] of [['Z first', zebra], ['A second', aardvark], ['Z third', zebra]]) {
    const created = await post(`/workspaces/${workspaceId}/tasks`, { project_id: project.id, title });
    const patched = await page.request.patch(`${origin}/api/v1/tasks/${created.id}`, { data: { expected_version: created.version, milestone_id: milestone.id }, headers });
    assert.ok(patched.ok(), await patched.text());
  }
  // A fresh session loads the new Project and Milestones.
  const fresh = await (await browser.newContext()).newPage();
  fresh.setDefaultTimeout(10000);
  await signIn(fresh);
  await fresh.getByRole('option', { name: 'Group project' }).first().waitFor({ state: 'attached' });
  const focusedLabel = () => fresh.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  await fresh.getByText('Advanced Smart List', { exact: true }).focus();
  await fresh.keyboard.press('Enter');
  await fresh.getByLabel('Advanced Smart List name').focus();
  await fresh.keyboard.type('By Milestone');
  await fresh.getByRole('button', { name: 'Add condition to Top group' }).focus();
  await fresh.keyboard.press('Enter');
  assert.equal(await focusedLabel(), 'Condition 1 field', 'focus moves to the new condition');
  // The new Status condition has no value yet: the builder refuses it instead of saving a List that matches nothing.
  await fresh.getByRole('button', { name: 'Create advanced Smart List' }).focus();
  await fresh.keyboard.press('Enter');
  await fresh.getByRole('status').filter({ hasText: 'Every condition needs a value.' }).waitFor();
  await fresh.getByRole('button', { name: 'Remove condition 1' }).focus();
  await fresh.keyboard.press('Enter');
  assert.equal(await focusedLabel(), 'Add condition to Top group', 'focus returns to the group Add button');
  await pick(fresh, 'Advanced Smart List group', 'Milestone');
  await fresh.getByRole('button', { name: 'Create advanced Smart List' }).focus();
  await fresh.keyboard.press('Enter');
  await fresh.getByRole('status').filter({ hasText: 'Created Smart List By Milestone' }).waitFor();
  await fresh.getByText('Z third', { exact: true }).first().waitFor();
  await fresh.locator('.table-group-heading').first().waitFor();
  const headings = await fresh.locator('.table-group-heading').allTextContents();
  assert.ok(headings.includes('Aardvark') && headings.includes('Zebra'), `group headings: ${headings}`);
  assert.ok(headings.indexOf('Aardvark') < headings.indexOf('Zebra'));
  assert.equal(headings.filter((heading) => heading === 'Zebra').length, 1, 'the two Zebra Tasks share one heading');
});
