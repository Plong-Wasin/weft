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
const schema = `weft_timeline_${randomUUID().replaceAll('-', '')}`;
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

async function seedPlan(page, label) {
  const csrf = (await page.context().cookies(origin)).find((cookie) => cookie.name === 'weft_csrf').value;
  const post = (path, data) => page.request.post(`${origin}/api/v1${path}`, { data, headers: { 'x-csrf-token': csrf } }).then((response) => response.json());
  const { today } = await page.request.get(`${origin}/api/v1/workspaces/${workspaceId}/settings`).then((response) => response.json());
  const project = await post(`/workspaces/${workspaceId}/projects`, { name: `Timeline ${label}`, visibility: 'workspace' });
  const milestone = await post(`/projects/${project.id}/milestones`, { name: `Ship ${label}`, target_date: addDays(today, 20) });
  const make = async (title, start, due, milestoneId) => {
    const created = await post(`/workspaces/${workspaceId}/tasks`, { project_id: project.id, title, status: 'backlog', start_date: addDays(today, start), due_date: addDays(today, due) });
    if (!milestoneId) return created;
    const assigned = await page.request.patch(`${origin}/api/v1/tasks/${created.id}`, { data: { expected_version: created.version, milestone_id: milestoneId }, headers: { 'x-csrf-token': csrf } });
    assert.equal(assigned.status(), 200);
    return assigned.json();
  };
  const first = await make(`${label} design`, 0, 2, milestone.id);
  const second = await make(`${label} build`, 3, 6, milestone.id);
  const loose = await make(`${label} loose`, 1, 4, null);
  return { today, csrf, first, second, loose, milestone };
}

async function openTimeline(page) {
  await page.getByRole('button', { name: 'My work', exact: true }).click();
  await page.getByRole('button', { name: 'All tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Timeline', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('group', { name: 'Timeline bars' }).waitFor().catch(async (error) => { console.error(await page.locator('main').innerText()); throw error; });
}

const taskOf = (page, number) => page.request.get(`${origin}/api/v1/workspaces/${workspaceId}/tasks/${number}`).then((response) => response.json());
const bar = (page, task, extra = '') => page.getByRole('button', { name: new RegExp(`^Task #${task.number} .*${extra}`) });

test('a keyboard-only journey groups by Milestone, moves a bar, adds a dependency and undoes both', async () => {
  const context = await browser.newContext();
  const page = await signIn(context);
  const { today, first, second, loose } = await seedPlan(page, 'kb');
  const other = await signIn(await browser.newContext());
  await page.reload();
  await page.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
  await openTimeline(page);
  await other.reload();
  await other.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
  await openTimeline(other);

  // Group by Milestone with the keyboard: a lane for the Milestone and one for loose work.
  await page.getByRole('button', { name: 'Group by Project', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: /^Timeline kb$/ }).waitFor();
  await page.getByRole('button', { name: 'Group by Milestone', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { level: 4, name: new RegExp(`^Milestone Ship kb`) }).waitFor();
  await page.getByRole('heading', { level: 4, name: 'No Milestone' }).waitFor();

  // Move the first bar one day later: only that Task changes, as one History entry.
  await bar(page, first, 'design').focus();
  await page.keyboard.press('Shift+ArrowRight');
  await page.getByRole('status').filter({ hasText: `Moved Task #${first.number}` }).waitFor();
  assert.deepEqual(((t) => [t.start_date, t.due_date])(await taskOf(page, first.number)), [addDays(today, 1), addDays(today, 3)]);
  assert.deepEqual(((t) => [t.start_date, t.due_date])(await taskOf(page, second.number)), [addDays(today, 3), addDays(today, 6)]);
  assert.deepEqual(((t) => [t.start_date, t.due_date])(await taskOf(page, loose.number)), [addDays(today, 1), addDays(today, 4)]);
  const history = await page.request.get(`${origin}/api/v1/tasks/${first.id}/history`).then((response) => response.json());
  assert.equal(history.operations.filter((operation) => operation.field === 'due_date').length, 1);
  // The second browser shows the change without a reload.
  await bar(other, first, `${addDays(today, 1)} to ${addDays(today, 3)}`).waitFor();

  // Resize the due date from the keyboard.
  await page.waitForFunction((id) => document.activeElement?.getAttribute('data-bar') === id, first.id);
  await page.keyboard.press('Shift+Alt+ArrowRight');
  await page.getByRole('status').filter({ hasText: `Resized Task #${first.number}` }).waitFor();
  assert.equal((await taskOf(page, first.number)).due_date, addDays(today, 4));
  await page.keyboard.press('Control+z');
  await bar(page, first, `${addDays(today, 1)} to ${addDays(today, 3)}`).waitFor();

  // Add a dependency: L marks the blocker, ArrowDown reaches the next bar, L makes it blocked.
  await page.keyboard.press('l');
  await page.getByRole('status').filter({ hasText: `Task #${first.number} is the blocker` }).waitFor();
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction((id) => document.activeElement?.getAttribute('data-bar') === id, second.id);
  await page.keyboard.press('l');
  await page.getByRole('status').filter({ hasText: `Task #${first.number} now blocks Task #${second.number}` }).waitFor();
  await page.locator(`[data-link="${first.number}>${second.number}"]`).waitFor({ state: 'attached' });
  await bar(other, second, `blocked by #${first.number}`).waitFor();

  // A loop is refused with the chain, by the same cycle check as the Task panel.
  await page.keyboard.press('l');
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction((id) => document.activeElement?.getAttribute('data-bar') === id, first.id);
  await page.keyboard.press('l');
  await page.getByRole('status').filter({ hasText: 'would form a loop' }).waitFor();

  // Undo the dependency, then the move.
  await page.keyboard.press('Control+z');
  await page.locator(`[data-link="${first.number}>${second.number}"]`).waitFor({ state: 'detached' });
  await page.keyboard.press('Control+z');
  await bar(page, first, `${addDays(today, 0)} to ${addDays(today, 2)}`).waitFor();
  assert.deepEqual(((t) => [t.start_date, t.due_date])(await taskOf(page, first.number)), [today, addDays(today, 2)]);
  await context.close();
});

test('the palette moves, resizes and links bars by Task number', async () => {
  const context = await browser.newContext();
  const page = await signIn(context);
  const { today, first, second } = await seedPlan(page, 'pal');
  await page.reload();
  await page.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
  await openTimeline(page);
  const run = async (text) => {
    await page.keyboard.press('Control+k');
    await page.getByRole('searchbox', { name: 'Search tasks and commands' }).fill(text);
    await page.keyboard.press('Enter');
  };
  await bar(page, first, 'design').focus();
  await run('timeline move 2');
  await page.getByRole('status').filter({ hasText: `Moved Task #${first.number}` }).waitFor();
  assert.deepEqual(((t) => [t.start_date, t.due_date])(await taskOf(page, first.number)), [addDays(today, 2), addDays(today, 4)]);
  await run('timeline resize start -1');
  await page.getByRole('status').filter({ hasText: `Resized Task #${first.number}` }).waitFor();
  assert.equal((await taskOf(page, first.number)).start_date, addDays(today, 1));
  await run(`timeline link ${first.number} blocks ${second.number}`);
  await page.getByRole('status').filter({ hasText: `Task #${first.number} now blocks Task #${second.number}` }).waitFor();
  await run(`timeline unlink ${first.number} blocks ${second.number}`);
  await page.getByRole('status').filter({ hasText: `no longer blocks Task #${second.number}` }).waitFor();
  await run('timeline group project');
  await page.getByRole('button', { name: 'Group by Project', exact: true }).and(page.locator('[aria-pressed="true"]')).waitFor();
  await context.close();
});

test('at phone width the Timeline is a grouped list with the same actions', async () => {
  const setup = await browser.newContext();
  const { today, first, second } = await seedPlan(await signIn(setup), 'ph');
  await setup.close();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await signIn(context);
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'My work', exact: true }).click();
  await page.getByRole('button', { name: 'All tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  const list = page.getByLabel('Timeline list');
  await list.waitFor();
  assert.equal(await page.getByRole('group', { name: 'Timeline bars' }).count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the list must not overflow horizontally');
  const move = list.getByRole('button', { name: `Move #${first.number} one day later` });
  assert.ok((await move.boundingBox()).height >= 44);
  await move.click();
  await page.getByRole('status').filter({ hasText: `Moved Task #${first.number}` }).waitFor();
  assert.deepEqual(((t) => [t.start_date, t.due_date])(await taskOf(page, first.number)), [addDays(today, 1), addDays(today, 3)]);
  await list.getByLabel(`Add blocker for Task #${second.number}`).selectOption({ label: `#${first.number} ${first.title}` });
  await page.getByRole('status').filter({ hasText: `Task #${first.number} now blocks Task #${second.number}` }).waitFor();
  await list.getByRole('button', { name: `Remove dependency on #${first.number}` }).click();
  await page.getByRole('status').filter({ hasText: `no longer blocks Task #${second.number}` }).waitFor();
  await context.close();
});

test('date-only moves cross a daylight-saving change and a month end without shifting a day', async () => {
  const context = await browser.newContext({ timezoneId: 'America/New_York' });
  const page = await signIn(context);
  const csrf = (await page.context().cookies(origin)).find((cookie) => cookie.name === 'weft_csrf').value;
  const post = (path, data) => page.request.post(`${origin}/api/v1${path}`, { data, headers: { 'x-csrf-token': csrf } }).then((response) => response.json());
  const project = await post(`/workspaces/${workspaceId}/projects`, { name: 'Timeline zones', visibility: 'workspace' });
  const make = (title, start_date, due_date) => post(`/workspaces/${workspaceId}/tasks`, { project_id: project.id, title, status: 'backlog', start_date, due_date });
  const clock = await make('zone clock', '2026-03-07', '2026-03-08');
  const month = await make('zone month', '2026-01-30', '2026-01-31');
  await page.reload();
  await page.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
  await openTimeline(page);
  await bar(page, clock, 'zone clock').focus();
  await page.keyboard.press('Shift+ArrowRight');
  await bar(page, clock, '2026-03-08 to 2026-03-09').waitFor();
  await page.keyboard.press('Shift+ArrowRight');
  await bar(page, clock, '2026-03-09 to 2026-03-10').waitFor();
  await bar(page, month, 'zone month').focus();
  await page.keyboard.press('Shift+ArrowRight');
  await bar(page, month, '2026-01-31 to 2026-02-01').waitFor();
  await page.keyboard.press('Shift+ArrowDown');
  await bar(page, month, '2026-02-07 to 2026-02-08').waitFor();
  assert.deepEqual(((t) => [t.start_date, t.due_date])(await taskOf(page, clock.number)), ['2026-03-09', '2026-03-10']);
  assert.deepEqual(((t) => [t.start_date, t.due_date])(await taskOf(page, month.number)), ['2026-02-07', '2026-02-08']);
  await context.close();
});
