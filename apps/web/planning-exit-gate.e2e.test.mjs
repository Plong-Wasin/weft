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

// Beta-2 exit gate in real browsers: two members see the same planning state, and undo, after each
// visible action; and the Milestone journey works with the keyboard only at phone width.

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const binary = resolve(appRoot, 'target/debug/weft');
const databaseUrl = process.env.WEFT_E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://weft:weft@127.0.0.1:55432/postgres';
const schema = `weft_planning_gate_${randomUUID().replaceAll('-', '')}`;
const vaultRoot = `/tmp/weft-e2e-vaults-${schema}`;
const password = 'planning gate password';
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
  run(binary, ['bootstrap-admin', 'owner@example.com', password, 'Planning Workspace'], env);
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
  await page.getByRole('button', { name: /Planning Workspace/ }).focus();
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


const csrf = async (target) => (await target.context().cookies()).find((cookie) => cookie.name === 'weft_csrf').value;

async function api(target, method, path, body) {
  const response = await target.request.fetch(`${origin}/api/v1${path}`, { method, headers: { 'x-csrf-token': await csrf(target) }, data: body });
  assert.ok(response.ok(), `${method} ${path} => ${response.status()} ${await response.text()}`);
  return response.json();
}

const waitForRequest = (page, part, method) => page.waitForResponse((response) => response.url().includes(part) && response.request().method() === method);

async function pressUndo(page) {
  const response = waitForRequest(page, `/workspaces/${workspaceId}/history/undo`, 'POST');
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await page.keyboard.press('Control+z');
  return response;
}

async function seed(actor, name, milestoneName) {
  const me = await actor.request.get(`${origin}/api/v1/auth/me`).then((response) => response.json());
  workspaceId = me.workspaces.find((item) => item.name === 'Planning Workspace').id;
  const project = await api(actor, 'POST', `/workspaces/${workspaceId}/projects`, { name, visibility: 'workspace' });
  const milestone = await api(actor, 'POST', `/projects/${project.id}/milestones`, { name: milestoneName, target_date: '2026-12-01' });
  const task = await api(actor, 'POST', `/workspaces/${workspaceId}/tasks`, { project_id: project.id, title: `${name} task`, status: 'active' });
  return { project, milestone, task };
}

const selectedMilestone = ({ number, label }) => document.querySelector(`select[aria-label="Milestone for #${number}"]`)?.selectedOptions[0]?.textContent === label;

test('two browsers show the same Milestone, progress and delivery state after each action and its undo', async () => {
  const actor = await (await browser.newContext()).newPage();
  actor.setDefaultTimeout(15000);
  await signIn(actor);
  const { project, milestone, task } = await seed(actor, 'Gate', 'Gate release');
  const page = await (await browser.newContext()).newPage();
  const other = await (await browser.newContext()).newPage();
  for (const target of [page, other]) {
    target.setDefaultTimeout(15000);
    await signIn(target);
    await target.getByLabel('Project', { exact: true }).selectOption({ label: 'Gate' });
  }
  const progress = (target) => target.getByRole('status', { name: 'Progress of Gate release' });
  const stateOf = async () => (await api(actor, 'GET', `/milestones/${milestone.id}`)).state;

  // Assign from the table with the keyboard; the other browser follows without a reload.
  const cell = page.getByLabel(`Milestone for #${task.number}`);
  await cell.focus();
  const saved = waitForRequest(page, `/workspaces/${workspaceId}/tasks/${task.number}`, 'PATCH');
  await page.keyboard.press('G');
  assert.equal((await saved).status(), 200);
  await other.waitForFunction(selectedMilestone, { number: task.number, label: 'Gate release' });
  await progress(page).getByText('0 of 1 done · 0%').waitFor();
  await progress(other).getByText('0 of 1 done · 0%').waitFor();

  // Undo reverts the assignment in both browsers; the Milestone stays empty ("no work yet").
  assert.equal((await pressUndo(page)).status(), 200);
  await other.waitForFunction(selectedMilestone, { number: task.number, label: 'No Milestone' });
  assert.equal((await api(actor, 'GET', `/workspaces/${workspaceId}/tasks/${task.number}`)).milestone_id, null);

  await page.waitForFunction(selectedMilestone, { number: task.number, label: 'No Milestone' });

  // Assign again, finish the Task: the Milestone asks for confirmation and never completes itself.
  const again = waitForRequest(page, `/workspaces/${workspaceId}/tasks/${task.number}`, 'PATCH');
  await cell.focus();
  await page.keyboard.press('G');
  assert.equal((await again).status(), 200);
  const current = await api(actor, 'GET', `/workspaces/${workspaceId}/tasks/${task.number}`);
  await api(actor, 'PATCH', `/tasks/${task.id}`, { expected_version: current.version, status: 'completed' });
  await progress(other).getByText('1 of 1 done · 100%').waitFor();
  await other.getByText('Ready to confirm delivery').waitFor();
  assert.equal(await stateOf(), 'planned');

  // Confirm and take the delivery back with the keyboard; both browsers agree each time.
  const confirm = other.getByRole('button', { name: 'Confirm delivery of Gate release' });
  await confirm.focus();
  await other.keyboard.press('Enter');
  await other.getByRole('button', { name: 'Undo delivery of Gate release' }).waitFor();
  await page.getByRole('button', { name: 'Undo delivery of Gate release' }).waitFor();
  assert.equal(await stateOf(), 'completed');
  const undo = other.getByRole('button', { name: 'Undo delivery of Gate release' });
  await undo.focus();
  await other.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Confirm delivery of Gate release' }).waitFor();
  assert.equal(await stateOf(), 'planned');
  assert.ok(project.id);
});

test('the Milestone journey works with the keyboard only at phone width', async () => {
  const actor = await (await browser.newContext()).newPage();
  actor.setDefaultTimeout(15000);
  await signIn(actor);
  const { task } = await seed(actor, 'Phone', 'Seeded plan');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  try {
    await signIn(page);
    await page.getByLabel('Project', { exact: true }).selectOption({ label: 'Phone' });
    const noScroll = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal scroll');
    await noScroll();

    await page.getByRole('heading', { name: 'Milestones · Phone' }).waitFor();
    await page.getByLabel('Milestone name').focus();
    await page.keyboard.type('Phone second');
    // Keystrokes must have landed in the field before Enter submits it.
    await page.waitForFunction(() => document.activeElement instanceof HTMLInputElement && document.activeElement.value === 'Phone second');
    await page.keyboard.press('Enter');
    await page.getByLabel('State of Phone second').waitFor();
    await noScroll();

    const cell = page.getByLabel(`Milestone for #${task.number}`);
    await cell.focus();
    const saved = waitForRequest(page, `/workspaces/${workspaceId}/tasks/${task.number}`, 'PATCH');
    await page.keyboard.press('P');
    assert.equal((await saved).status(), 200);
    await page.getByRole('status', { name: 'Progress of Phone second' }).getByText('0 of 1 done · 0%').waitFor();
    await noScroll();
  } finally {
    await context.close();
  }
});
