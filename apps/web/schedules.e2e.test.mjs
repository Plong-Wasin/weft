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

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const binary = resolve(appRoot, 'target/debug/weft');
const databaseUrl = process.env.WEFT_E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://weft:weft@127.0.0.1:55432/postgres';
const schema = `weft_schedules_${randomUUID().replaceAll('-', '')}`;
const vaultRoot = `/tmp/weft-e2e-vaults-${schema}`;
const password = 'keyboard test password';
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
  run(binary, ['bootstrap-admin', 'owner@example.com', password, 'Keyboard Workspace'], env);
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



const sqlIn = (sql) => psql(`SET search_path=${schema}; ${sql}`);

async function signIn(browserContext) {
  const page = await browserContext.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(origin);
  await page.getByLabel('Email').fill('owner@example.com');
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
  workspaceId = (await page.request.get(`${origin}/api/v1/auth/me`).then((response) => response.json())).workspaces[0].id;
  return page;
}

async function key(page, name) {
  await page.keyboard.press(name);
}

async function openSchedules(page) {
  await page.getByRole('button', { name: 'More', exact: true }).focus();
  await key(page, 'Enter');
  await page.getByRole('dialog', { name: 'More' }).getByRole('button', { name: 'Settings' }).focus();
  await key(page, 'Enter');
  await page.getByRole('button', { name: 'AI schedules', exact: true }).waitFor().catch(async (error) => { console.error(await page.locator('body').innerText()); throw error; });
  await page.getByRole('button', { name: 'AI schedules', exact: true }).focus();
  await key(page, 'Enter');
  await page.getByRole('heading', { name: 'AI schedules' }).waitFor();
}

async function palette(page, query) {
  await key(page, 'Control+k');
  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  await dialog.waitFor();
  await dialog.getByRole('searchbox', { name: 'Search tasks and commands' }).fill(query);
  return dialog;
}

test('a keyboard-only admin creates, disables and re-enables Schedules and AI Connections, also from the palette', async () => {
  const page = await signIn(await browser.newContext());
  const csrf = (await page.context().cookies(origin)).find((cookie) => cookie.name === 'weft_csrf').value;
  const post = (path, data) => page.request.post(`${origin}/api/v1${path}`, { data, headers: { 'x-csrf-token': csrf } }).then((response) => response.json());
  await post(`/workspaces/${workspaceId}/projects`, { name: 'Reviewed project', visibility: 'workspace' });
  await post(`/workspaces/${workspaceId}/ai/service-principals`, { name: 'Weekly reviewer' });
  const connectionId = randomUUID();
  sqlIn(`INSERT INTO ai_connections(id,scope,workspace_id,provider,auth_mode,billing_mode,state,state_reason,created_by) SELECT '${connectionId}','workspace','${workspaceId}','scripted','provider_cli','api','ready','Connection is ready',id FROM users LIMIT 1; INSERT INTO ai_connection_grants(connection_id,workspace_id) VALUES('${connectionId}','${workspaceId}');`);
  await page.reload();
  await page.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
  await openSchedules(page);

  // Create a Schedule with the keyboard only; it starts off.
  await page.getByLabel('Schedule name').focus();
  await page.keyboard.type('Weekly review');
  await key(page, 'Enter');
  const item = page.getByRole('listitem', { name: 'Schedule Weekly review' });
  await item.waitFor();
  await item.getByText(/State: off/).waitFor();
  // Enabling is its own explicit action.
  await item.getByRole('button', { name: 'Enable Schedule Weekly review' }).focus();
  await key(page, 'Enter');
  await item.getByText(/State: active/).waitFor();
  // Run history opens by keyboard and shows a seeded run with its reason.
  const scheduleId = (await page.request.get(`${origin}/api/v1/workspaces/${workspaceId}/ai/schedules`).then((response) => response.json())).schedules[0].id;
  sqlIn(`INSERT INTO ai_schedule_runs(id,schedule_id,workspace_id,scheduled_for,state,reason) VALUES('${randomUUID()}','${scheduleId}','${workspaceId}','2026-06-01T09:00:00Z','skipped','previous_run_still_active');`);
  await item.getByRole('button', { name: 'Run history for Weekly review' }).focus();
  await key(page, 'Enter');
  await page.getByRole('table', { name: 'Run history for Weekly review' }).getByText(/previous_run_still_active/).waitFor();

  // The emergency switch on the Schedule is one keypress and its state, reason and audit are visible.
  await item.getByRole('button', { name: 'Disable Schedule Weekly review' }).focus();
  await key(page, 'Enter');
  await item.getByText(/State: stopped · disabled_by_admin/).waitFor();
  await item.getByText('Disabled by a Workspace Admin').waitFor();
  await page.getByRole('status').filter({ hasText: 'Queued runs were cancelled' }).waitFor();
  const audit = await page.request.get(`${origin}/api/v1/workspaces/${workspaceId}/ai/schedules/${scheduleId}/audit`).then((response) => response.json());
  assert.ok(audit.events.some((event) => event.event === 'ai.schedule.disabled' && event.actor_id));
  // Nothing re-enabled it by itself.
  await page.reload();
  await page.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
  await openSchedules(page);
  await page.getByRole('listitem', { name: 'Schedule Weekly review' }).getByText(/State: stopped/).waitFor();

  // Re-enable (explicit), then disable from the command palette.
  await page.getByRole('button', { name: 'Enable Schedule Weekly review' }).focus();
  await key(page, 'Enter');
  await page.getByRole('listitem', { name: 'Schedule Weekly review' }).getByText(/State: active/).waitFor();
  await key(page, 'Escape');
  const found = await palette(page, 'emergency disable weekly');
  await found.getByRole('option', { name: /Emergency disable Schedule: Weekly review/ }).waitFor();
  await key(page, 'Tab');
  await found.getByRole('option', { name: /Emergency disable Schedule: Weekly review/ }).focus();
  await key(page, 'Enter');
  await page.getByRole('listitem', { name: 'Schedule Weekly review' }).getByText(/State: stopped · disabled_by_admin/).waitFor();

  // The AI Connection switch, from its own list and from the palette.
  const connection = page.getByRole('listitem', { name: /^AI Connection scripted/ });
  await connection.getByRole('button', { name: /^Disable AI Connection scripted/ }).focus();
  await key(page, 'Enter');
  await connection.getByText(/disabled/).first().waitFor();
  await connection.getByRole('button', { name: /^Enable AI Connection scripted/ }).focus();
  await key(page, 'Enter');
  await connection.getByRole('button', { name: /^Disable AI Connection scripted/ }).waitFor();
  const viaPalette = await palette(page, 'disable connection');
  await viaPalette.getByRole('option', { name: /Emergency disable AI Connection: scripted/ }).focus();
  await key(page, 'Enter');
  await connection.getByRole('button', { name: /^Enable AI Connection scripted/ }).waitFor();
  const state = await page.request.get(`${origin}/api/v1/ai/connections`).then((response) => response.json());
  assert.equal(state.connections.find((item) => item.id === connectionId).enabled, false);

  // The palette opens the screen from anywhere.
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  const open = await palette(page, 'schedules');
  await open.getByRole('option', { name: /Schedules: open the AI schedules screen/ }).focus();
  await key(page, 'Enter');
  await page.getByRole('heading', { name: 'AI schedules' }).waitFor();
});
