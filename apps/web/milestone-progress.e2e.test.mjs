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
const schema = `weft_progress_${randomUUID().replaceAll('-', '')}`;
const vaultRoot = `/tmp/weft-e2e-vaults-${schema}`;
const password = 'progress test password';
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
  run(binary, ['bootstrap-admin', 'owner@example.com', password, 'Progress Workspace'], env);
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
  await page.getByRole('button', { name: /Progress Workspace/ }).focus();
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

test('progress follows Status changes in a second browser and delivery is confirmed by keyboard', async () => {
  const actor = await (await browser.newContext()).newPage();
  actor.setDefaultTimeout(10000);
  await signIn(actor);
  const me = await actor.request.get(`${origin}/api/v1/auth/me`).then((response) => response.json());
  workspaceId = me.workspaces[0].id;
  const csrf = async (target) => (await target.context().cookies()).find((cookie) => cookie.name === 'weft_csrf').value;
  const api = async (target, method, path, body) => {
    const response = await target.request.fetch(`${origin}/api/v1${path}`, { method, headers: { 'x-csrf-token': await csrf(target) }, data: body });
    assert.ok(response.ok(), `${method} ${path} => ${response.status()} ${await response.text()}`);
    return response.json();
  };

  const project = await api(actor, 'POST', `/workspaces/${workspaceId}/projects`, { name: 'Plan project', visibility: 'workspace' });
  const milestone = await api(actor, 'POST', `/projects/${project.id}/milestones`, { name: 'Beta release', target_date: '2026-12-01' });
  const first = await api(actor, 'POST', `/workspaces/${workspaceId}/tasks`, { project_id: project.id, title: 'Write the plan', status: 'active' });
  await api(actor, 'PATCH', `/tasks/${first.id}`, { expected_version: first.version, milestone_id: milestone.id });
  const page = await (await browser.newContext()).newPage();
  page.setDefaultTimeout(10000);
  await signIn(page);
  const other = await (await browser.newContext()).newPage();
  other.setDefaultTimeout(10000);
  await signIn(other);
  for (const target of [page, other]) await target.getByLabel('Project', { exact: true }).selectOption({ label: 'Plan project' });

  const progress = (target) => target.getByRole('status', { name: 'Progress of Beta release' });
  await progress(page).getByText('0 of 1 done · 0%').waitFor();
  await progress(other).getByText('0 of 1 done · 0%').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Confirm delivery of Beta release' }).count(), 0);

  // The Task finishes in the first browser; the second one updates without a reload.
  const current = await api(actor, 'GET', `/workspaces/${workspaceId}/tasks/${first.number}`);
  await api(actor, 'PATCH', `/tasks/${first.id}`, { expected_version: current.version, status: 'completed' });
  await progress(other).getByText('1 of 1 done · 100%').waitFor();
  await other.getByText('Ready to confirm delivery').waitFor();
  assert.equal((await api(actor, 'GET', `/milestones/${milestone.id}`)).state, 'planned');

  // Confirm and undo with the keyboard alone.
  const confirm = other.getByRole('button', { name: 'Confirm delivery of Beta release' });
  await confirm.focus();
  await other.keyboard.press('Enter');
  const undo = other.getByRole('button', { name: 'Undo delivery of Beta release' });
  await undo.waitFor();
  assert.equal((await api(actor, 'GET', `/milestones/${milestone.id}`)).state, 'completed');
  await undo.focus();
  await other.keyboard.press('Enter');
  await confirm.waitFor();
  assert.equal((await api(actor, 'GET', `/milestones/${milestone.id}`)).state, 'planned');
});
