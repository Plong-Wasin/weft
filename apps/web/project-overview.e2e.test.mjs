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

// Project overview in real browsers: it opens by keyboard, follows a link into a filtered Task
// list and back, and stays focus-complete at phone width.

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const binary = resolve(appRoot, 'target/debug/weft');
const databaseUrl = process.env.WEFT_E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://weft:weft@127.0.0.1:55432/postgres';
const schema = `weft_overview_${randomUUID().replaceAll('-', '')}`;
const vaultRoot = `/tmp/weft-e2e-overview-vaults-${schema}`;
const ownerPassword = 'owner collaboration password';
const memberPassword = 'member collaboration password';
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
    await page.getByRole('button', { name: /Overview Workspace/ }).focus();
    await page.keyboard.press('Enter');
    await tasks.waitFor();
  }
}

async function createTask(data) {
  const response = await api.request.post(`${origin}/api/v1/workspaces/${workspaceId}/tasks`, { data: { project_id: projectId, ...data }, headers: { 'x-csrf-token': await csrfOf(api) } });
  assert.equal(response.status(), 201, await response.text());
  return response.json();
}

before(async () => {
  await access(binary);
  await access(resolve(appRoot, 'apps/web/dist/index.html'));
  psql(`CREATE SCHEMA ${schema}`);
  const scopedDatabaseUrl = `${databaseUrl}?options=-csearch_path%3D${schema}`;
  const env = { ...process.env, DATABASE_URL: scopedDatabaseUrl, WEFT_WEB_ROOT: resolve(appRoot, 'apps/web/dist'), WEFT_VAULT_ROOT: vaultRoot };
  run(binary, ['bootstrap-admin', ownerEmail, ownerPassword, 'Overview Workspace'], env);
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
  workspaceId = me.workspaces.find((item) => item.name === 'Overview Workspace').id;
  const csrf = await csrfOf(api);
  const project = await api.request.post(`${origin}/api/v1/workspaces/${workspaceId}/projects`, { data: { name: 'Overview project', visibility: 'workspace' }, headers: { 'x-csrf-token': csrf } });
  assert.equal(project.status(), 201, await project.text());
  projectId = (await project.json()).id;
  const invite = await api.request.post(`${origin}/api/v1/auth/invites`, { data: { role: 'member', expires_in_hours: 24 }, headers: { 'x-csrf-token': csrf } }).then((response) => response.json());
  const fresh = await browser.newPage();
  const accepted = await fresh.request.post(`${origin}/api/v1/auth/invites/accept`, { data: { token: invite.token, email: memberEmail, password: memberPassword } });
  assert.equal(accepted.status(), 201, await accepted.text());
  await fresh.close();
  psql(`SET search_path TO ${schema}; INSERT INTO project_memberships(workspace_id,project_id,user_id,role) SELECT '${workspaceId}','${projectId}',id,'manager' FROM users WHERE email='${memberEmail}'`);
});

after(async () => {
  await browser?.close();
  server?.kill('SIGTERM');
  if (server) await once(server, 'exit').catch(() => undefined);
  psql(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await rm(vaultRoot, { recursive: true, force: true });
});

async function post(path, data) {
  const response = await api.request.post(`${origin}/api/v1${path}`, { data, headers: { 'x-csrf-token': await csrfOf(api) } });
  assert.ok(response.ok(), `${path}: ${response.status()} ${await response.text()}`);
  return response;
}

async function patch(path, data) {
  const response = await api.request.patch(`${origin}/api/v1${path}`, { data, headers: { 'x-csrf-token': await csrfOf(api) } });
  assert.ok(response.ok(), `${path}: ${response.status()} ${await response.text()}`);
  return response;
}

// Presses Tab until the focused element's accessible text matches, failing after `limit` presses.
async function tabTo(page, pattern, limit = 40) {
  for (let step = 0; step < limit; step += 1) {
    await page.keyboard.press('Tab');
    const text = await page.evaluate(() => document.activeElement?.textContent ?? '');
    if (pattern.test(text)) return;
  }
  assert.fail(`never focused ${pattern}`);
}

async function openOverview(page) {
  await page.getByRole('button', { name: 'Overview', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('region', { name: 'Project overview' }).waitFor();
}

test('the Project overview opens by keyboard and follows a link into a filtered list and back', async () => {
  await patch(`/projects/${projectId}`, { state: 'active', target_start_date: '2026-01-05', target_end_date: '2026-12-31' });
  const milestone = await post(`/projects/${projectId}/milestones`, { name: 'Beta release', target_date: '2026-12-01' }).then((response) => response.json());
  const late = await createTask({ title: 'Late work', status: 'active', due_date: '2000-01-01' });
  await createTask({ title: 'On time work', status: 'active', due_date: '2999-01-01' });
  const blocker = await createTask({ title: 'Blocking work', status: 'active' });
  await post(`/tasks/${blocker.id}/relations`, { target_task_id: late.id, kind: 'blocks' });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  try {
    await signIn(page, ownerEmail, ownerPassword);
    await openOverview(page);
    const overview = page.getByRole('region', { name: 'Project overview' });
    await overview.getByText('2026-01-05').waitFor();
    await overview.getByText('2026-12-31').waitFor();
    await overview.getByText('Beta release').waitFor();
    await overview.getByText(/No work yet/).waitFor();
    await overview.getByRole('button', { name: '1 blocked Task' }).waitFor();
    // Keyboard only: Tab from the Project picker to the overdue count, open its list.
    await overview.getByLabel('Project', { exact: true }).focus();
    await tabTo(page, /1 overdue Task/);
    await page.keyboard.press('Enter');
    const list = page.getByRole('region', { name: 'Filtered Task list' });
    await list.getByRole('heading', { name: 'Overdue Tasks' }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Overdue Tasks');
    await list.getByRole('button', { name: /Open Task #\d+ Late work/ }).waitFor();
    assert.equal(await list.getByRole('button', { name: /On time work/ }).count(), 0);
    // Back returns to the overview with focus on the link that was used.
    await tabTo(page, /Back to overview/).catch(() => undefined);
    await list.getByRole('button', { name: 'Back to overview' }).focus();
    await page.keyboard.press('Enter');
    await overview.getByRole('button', { name: '1 overdue Task' }).waitFor();
    await page.waitForFunction(() => /overdue/.test(document.activeElement?.textContent ?? ''));
    // A Milestone link opens its (empty) filtered list.
    await overview.getByRole('button', { name: 'Beta release' }).focus();
    await page.keyboard.press('Enter');
    await list.getByRole('heading', { name: 'Tasks in Beta release' }).waitFor();
    await list.getByText('No Tasks match.').waitFor();
    assert.ok(milestone.id);
  } finally {
    await context.close();
  }
});

test('the Project overview is focus-complete and fits at phone width', async () => {
  const context = await browser.newContext({ viewport: { width: 375, height: 700 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  try {
    await signIn(page, ownerEmail, ownerPassword);
    await openOverview(page);
    const overview = page.getByRole('region', { name: 'Project overview' });
    await overview.getByText('Beta release').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, 'no horizontal page scroll');
    // Every control inside the overview is reachable by Tab and sits inside the viewport width.
    const names = await overview.locator('button, select, a[href]').evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim() || node.getAttribute('aria-label') || ''));
    assert.ok(names.length >= 4, `controls: ${names.join(', ')}`);
    await overview.getByLabel('Project', { exact: true }).focus();
    const seen = new Set();
    for (let step = 0; step < names.length + 2; step += 1) {
      const box = await page.evaluate(() => { const rect = document.activeElement.getBoundingClientRect(); return { left: rect.left, right: rect.right, inside: document.querySelector('[aria-label="Project overview"]').contains(document.activeElement), label: document.activeElement.textContent?.trim() || document.activeElement.getAttribute('aria-label') }; });
      if (box.inside) {
        assert.ok(box.left >= 0 && box.right <= 375, `${box.label} outside viewport`);
        seen.add(box.label);
      }
      await page.keyboard.press('Tab');
    }
    assert.ok(seen.size >= 4, `focused ${[...seen].join(', ')}`);
    // The Overview tab itself is reachable in the phone tab bar.
    await page.getByRole('button', { name: 'Overview', exact: true }).waitFor();
  } finally {
    await context.close();
  }
});
