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
import { goTo, setView, taskPanel } from './e2e-helpers.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const binary = resolve(appRoot, 'target/debug/weft');
const databaseUrl = process.env.WEFT_E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://weft:weft@127.0.0.1:55432/postgres';
const schema = `weft_calendar_${randomUUID().replaceAll('-', '')}`;
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


const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

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

async function seed(page, titles) {
  const csrf = (await page.context().cookies(origin)).find((cookie) => cookie.name === 'weft_csrf').value;
  const post = (path, data) => page.request.post(`${origin}/api/v1${path}`, { data, headers: { 'x-csrf-token': csrf } }).then((response) => response.json());
  const { today } = await page.request.get(`${origin}/api/v1/workspaces/${workspaceId}/settings`).then((response) => response.json());
  const project = await post(`/workspaces/${workspaceId}/projects`, { name: `Calendar ${titles[0]}`, visibility: 'workspace' });
  const tasks = [];
  for (const [index, title] of titles.entries()) tasks.push(await post(`/workspaces/${workspaceId}/tasks`, { project_id: project.id, title, status: 'todo', start_date: addDays(today, -1 - index), due_date: addDays(today, index) }));
  return { today, csrf, tasks };
}

async function openCalendar(page) {
  await page.getByRole('button', { name: 'My work', exact: true }).click();
  await page.getByRole('button', { name: 'All tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Calendar', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('grid', { name: /^Calendar / }).waitFor();
}

const dueOf = (page, number) => page.request.get(`${origin}/api/v1/workspaces/${workspaceId}/tasks/${number}`).then((response) => response.json()).then((task) => task.due_date);

test('a keyboard-only journey picks a day, changes the range, moves a Task date and undoes it', async () => {
  const context = await browser.newContext();
  const page = await signIn(context);
  const { today, tasks } = await seed(page, ['Calendar keyboard task']);
  const [task] = tasks;
  await page.reload();
  await page.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
  await openCalendar(page);

  // Choose a day and change the range with the keyboard.
  const cell = (date) => page.locator(`[data-day="${date}"]`);
  await cell(today).focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction((date) => document.activeElement?.getAttribute('data-day') === date, addDays(today, 1));
  assert.equal(await cell(addDays(today, 1)).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('t');
  await page.waitForFunction((date) => document.activeElement?.getAttribute('data-day') === date, today);
  await page.keyboard.press('PageDown');
  await page.getByRole('heading', { level: 3 }).filter({ hasText: /\d{4}/ }).waitFor();
  await page.keyboard.press('t');
  await page.waitForFunction((date) => document.activeElement?.getAttribute('data-day') === date, today);

  // The Task shows on its start and due dates; Enter on the day reaches it.
  const due = page.getByRole('button', { name: `Task #${task.number} Calendar keyboard task, due ${today}` });
  const start = page.getByRole('button', { name: `Task #${task.number} Calendar keyboard task, start ${addDays(today, -1)}` });
  await start.waitFor();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-entry')?.endsWith(':due'));

  // Move the due date by one day, then undo with the same keyboard.
  await page.keyboard.press('Shift+ArrowRight');
  await page.getByRole('status').filter({ hasText: `Moved Task #${task.number} due date to ${addDays(today, 1)}` }).waitFor();
  assert.equal(await dueOf(page, task.number), addDays(today, 1));
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-entry')?.endsWith(':due'));
  const history = await page.request.get(`${origin}/api/v1/tasks/${task.id}/history`).then((response) => response.json());
  assert.equal(history.operations.filter((operation) => operation.field === 'due_date').length, 1);
  await page.keyboard.press('Control+z');
  await page.waitForFunction(async ({ url }) => (await fetch(url).then((response) => response.json())).due_date, { url: `${origin}/api/v1/workspaces/${workspaceId}/tasks/${task.number}` });
  await page.getByRole('button', { name: `Task #${task.number} Calendar keyboard task, due ${today}` }).waitFor();
  assert.equal(await dueOf(page, task.number), today);

  // The palette offers the same actions.
  await page.keyboard.press('Control+k');
  await page.getByRole('searchbox', { name: 'Search tasks and commands' }).fill('calendar week');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Week', exact: true }).and(page.locator('[aria-pressed="true"]')).waitFor();
  await page.keyboard.press('Control+k');
  await page.getByRole('searchbox', { name: 'Search tasks and commands' }).fill(`calendar move due ${addDays(today, 2)}`);
  await page.keyboard.press('Enter');
  await page.getByRole('status').filter({ hasText: `due date to ${addDays(today, 2)}` }).waitFor();
  assert.equal(await dueOf(page, task.number), addDays(today, 2));

  // Enter on a Task opens it.
  await page.getByRole('button', { name: `Task #${task.number} Calendar keyboard task, due ${addDays(today, 2)}` }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('region', { name: `Task #${task.number}` }).waitFor();
  await context.close();
});

test('a conflicting date change shows the current value and keeps the draft', async () => {
  const context = await browser.newContext();
  const page = await signIn(context);
  const { today, csrf, tasks } = await seed(page, ['Calendar conflict task']);
  const [task] = tasks;
  await page.reload();
  await page.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
  await openCalendar(page);
  const entry = page.getByRole('button', { name: `Task #${task.number} Calendar conflict task, due ${today}` });
  await entry.focus();
  // Someone else changes the Task after the Calendar loaded it.
  const other = await page.request.patch(`${origin}/api/v1/tasks/${task.id}`, { data: { expected_version: task.version, due_date: addDays(today, 5) }, headers: { 'x-csrf-token': csrf } });
  assert.equal(other.status(), 200);
  await page.keyboard.press('Shift+ArrowRight');
  const alert = page.getByRole('alert').filter({ hasText: 'changed on the server' });
  await alert.waitFor();
  await alert.getByText(`Current due date: ${addDays(today, 5)}`).waitFor();
  await alert.getByText(`Your date ${addDays(today, 1)} is kept here`).waitFor();
  assert.equal(await dueOf(page, task.number), addDays(today, 5));
  await alert.getByRole('button', { name: `Apply ${addDays(today, 1)} to the current Task` }).click();
  await page.getByRole('status').filter({ hasText: `due date to ${addDays(today, 1)}` }).waitFor();
  assert.equal(await dueOf(page, task.number), addDays(today, 1));
  await context.close();
});

test('at phone width the Calendar is an agenda list that is focus-complete', async () => {
  const setup = await browser.newContext();
  const { today, tasks } = await seed(await signIn(setup), ['Calendar phone task']);
  await setup.close();
  const [task] = tasks;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await signIn(context);
  await page.getByRole('navigation', { name: 'Primary' }).waitFor();
  await goTo(page, 'My work');
  await goTo(page, 'All tasks');
  await setView(page, 'Calendar');
  const agenda = page.getByRole('region', { name: 'Calendar agenda' });
  await agenda.waitFor();
  assert.equal(await page.getByRole('grid', { name: /^Calendar / }).count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'agenda must not overflow horizontally');
  // Every control in the agenda is a real focusable control with a touch-sized target.
  const dueInput = agenda.getByLabel(`Due date of Task #${task.number}`);
  await dueInput.waitFor();
  assert.ok((await dueInput.boundingBox()).height >= 44);
  assert.ok((await agenda.getByRole('button', { name: new RegExp(`#${task.number} Calendar phone task`) }).first().boundingBox()).height >= 44);
  await dueInput.fill(addDays(today, 3));
  await page.getByRole('status').filter({ hasText: `due date to ${addDays(today, 3)}` }).waitFor();
  assert.equal(await dueOf(page, task.number), addDays(today, 3));
  await agenda.getByRole('button', { name: new RegExp(`#${task.number} Calendar phone task`) }).last().click();
  await page.getByRole('region', { name: `Task #${task.number}` }).waitFor();
  await context.close();
});
