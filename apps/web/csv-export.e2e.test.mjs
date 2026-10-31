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
const schema = `weft_csvexport_${randomUUID().replaceAll('-', '')}`;
const vaultRoot = `/tmp/weft-e2e-vaults-${schema}`;
const password = 'export test password';
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
  run(binary, ['bootstrap-admin', 'owner@example.com', password, 'Export Workspace'], env);
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

test('a keyboard user exports the current view as CSV with formulas neutralised and a not-a-backup notice', async () => {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(origin);
  await page.getByLabel('Email').fill('owner@example.com');
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Choose a Workspace' }).waitFor();
  await page.getByRole('button', { name: /Export Workspace/ }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
  const csrf = (await context.cookies()).find((cookie) => cookie.name === 'weft_csrf').value;
  const api = (path, data) => page.request.post(`${origin}/api/v1${path}`, { data, headers: { 'x-csrf-token': csrf } });
  const project = await (await api(`/workspaces/${await currentWorkspace(page)}/projects`, { name: 'Open', visibility: 'workspace' })).json();
  for (const title of ['=1+1', 'งานด่วน, "สำคัญ"']) {
    const created = await api(`/workspaces/${project.workspace_id}/tasks`, { project_id: project.id, title });
    assert.ok(created.ok());
  }
  await page.reload();
  await page.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
  const myWorkLoaded = page.waitForResponse((response) => response.url().includes('/my-work') && response.request().method() === 'GET');
  await page.getByRole('button', { name: 'My work', exact: true }).click();
  await myWorkLoaded;
  await page.getByRole('button', { name: 'All tasks', exact: true }).click();
  await page.getByText('=1+1').first().waitFor();

  // Keyboard only: focus the button and press Enter.
  const button = page.getByRole('button', { name: 'Export view as CSV' });
  await button.focus();
  const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
  const path = await download.path();
  const text = (await readFile(path, 'utf8')).replace(/^﻿/, '');
  assert.match(text, /'=1\+1/);
  assert.doesNotMatch(text, /(^|,)=1\+1/m);
  assert.ok(text.includes('"งานด่วน, ""สำคัญ"""'));
  assert.match(text, /not a backup/i);
  await page.getByRole('status').filter({ hasText: /not a backup/i }).first().waitFor();

  // Command palette path.
  await page.keyboard.press('Control+k');
  await page.getByRole('dialog', { name: 'Command palette' }).waitFor();
  await page.keyboard.type('export csv');
  const [second] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
  assert.match(await readFile(await second.path(), 'utf8'), /'=1\+1/);
  await context.close();
});

async function currentWorkspace(page) {
  const me = await page.request.get(`${origin}/api/v1/auth/me`).then((response) => response.json());
  return me.workspaces.find((item) => item.name === 'Export Workspace').id;
}
