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

// Blocker view in real browsers: it opens by keyboard, walks with arrow keys and follows a
// dependency change made in another browser without a reload.

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const binary = resolve(appRoot, 'target/debug/weft');
const databaseUrl = process.env.WEFT_E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://weft:weft@127.0.0.1:55432/postgres';
const schema = `weft_blockers_${randomUUID().replaceAll('-', '')}`;
const vaultRoot = `/tmp/weft-e2e-blockers-vaults-${schema}`;
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
    await page.getByRole('button', { name: /Blockers Workspace/ }).focus();
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
  run(binary, ['bootstrap-admin', ownerEmail, ownerPassword, 'Blockers Workspace'], env);
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
  workspaceId = me.workspaces.find((item) => item.name === 'Blockers Workspace').id;
  const csrf = await csrfOf(api);
  const project = await api.request.post(`${origin}/api/v1/workspaces/${workspaceId}/projects`, { data: { name: 'Blockers project', visibility: 'workspace' }, headers: { 'x-csrf-token': csrf } });
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

async function openBlockers(page) {
  await page.getByRole('button', { name: 'Blockers', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('region', { name: 'Blockers' }).waitFor();
}

test('the Blocker view is keyboard-usable and follows changes made in another browser', async () => {
  const [ownerContext, memberContext] = await Promise.all([browser.newContext(), browser.newContext()]);
  const [owner, member] = await Promise.all([ownerContext.newPage(), memberContext.newPage()]);
  owner.setDefaultTimeout(15000);
  member.setDefaultTimeout(15000);
  try {
    await signIn(owner, ownerEmail, ownerPassword);
    await signIn(member, memberEmail, memberPassword);
    await Promise.all([openBlockers(owner), openBlockers(member)]);
    for (const page of [owner, member]) await page.getByText('Nothing is blocked.').waitFor();
    const blocker = await createTask({ title: 'Upstream blocker' });
    const waiting = await createTask({ title: 'Downstream waiting' });
    await post(`/tasks/${blocker.id}/relations`, { target_task_id: waiting.id, kind: 'blocks' });
    // Both browsers update on their own through the realtime stream.
    for (const page of [owner, member]) await page.getByRole('button', { name: /Open Task #\d+ Downstream waiting/ }).waitFor();
    // Keyboard: focus the blocked Task, ArrowDown lands on its blocker, Enter opens that Task.
    const first = member.getByRole('button', { name: /Open Task #\d+ Downstream waiting/ });
    await first.focus();
    await member.keyboard.press('ArrowDown');
    const upstream = member.getByRole('button', { name: /Blocked by #\d+ Upstream blocker/ });
    assert.equal(await upstream.evaluate((node) => node === document.activeElement), true, 'ArrowDown moves focus to the blocker');
    await member.keyboard.press('Enter');
    await member.getByRole('region', { name: `Task #${blocker.number}` }).waitFor();
    // Removing the relation elsewhere clears the entry in the other browser.
    const removed = await api.request.delete(`${origin}/api/v1/tasks/${blocker.id}/relations/${waiting.id}/blocks`, { headers: { 'x-csrf-token': await csrfOf(api) } });
    assert.ok(removed.ok(), await removed.text());
    await owner.getByText('Nothing is blocked.').waitFor();
  } finally {
    await ownerContext.close();
    await memberContext.close();
  }
});
