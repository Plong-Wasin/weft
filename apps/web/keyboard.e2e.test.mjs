import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { after, before, test } from 'node:test';
import { access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const binary = resolve(appRoot, 'target/debug/weft');
const databaseUrl = process.env.WEFT_E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://weft:weft@127.0.0.1:55432/postgres';
const schema = `weft_keyboard_${process.pid}_${Date.now()}`;
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
  const env = { ...process.env, DATABASE_URL: scopedDatabaseUrl, WEFT_WEB_ROOT: resolve(appRoot, 'apps/web/dist') };
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
});

test('keyboard users can edit tasks, use the palette, undo changes, and type Thai safely', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(origin);
  await page.getByLabel('Email').fill('owner@example.com');
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();

  const csrf = (await context.cookies(origin)).find((cookie) => cookie.name === 'weft_csrf')?.value;
  const post = (path, data) => page.request.post(`${origin}${path}`, { data, headers: { 'x-csrf-token': csrf } });
  const me = await page.request.get(`${origin}/api/v1/auth/me`).then((response) => response.json());
  workspaceId = me.workspaces[0].id;
  const projectResponse = await post(`/api/v1/workspaces/${workspaceId}/projects`, { name: 'Keyboard project', visibility: 'workspace' });
  assert.equal(projectResponse.status(), 201);
  const project = await projectResponse.json();
  const statusResponse = await post(`/api/v1/workspaces/${workspaceId}/statuses`, { name: 'Ready for review', category: 'active' });
  assert.equal(statusResponse.status(), 201);
  const status = await statusResponse.json();
  const attributeResponse = await post(`/api/v1/workspaces/${workspaceId}/attributes`, { name: 'Effort', value_type: 'single_select', project_ids: [project.id], options: ['Small', 'Large'] });
  assert.equal(attributeResponse.status(), 201);
  const attribute = await attributeResponse.json();
  const attributeList = await page.request.get(`${origin}/api/v1/workspaces/${workspaceId}/attributes`).then((response) => response.json());
  assert.deepEqual(attributeList.attributes.find((item) => item.id === attribute.id).options.map((item) => item.name), ['Small', 'Large']);
  const createTask = (title) => post(`/api/v1/workspaces/${workspaceId}/tasks`, { project_id: project.id, title });
  const firstTaskResponse = await createTask('Keyboard first task');
  assert.equal(firstTaskResponse.status(), 201);
  const secondTaskResponse = await createTask('Thai IME journey');
  assert.equal(secondTaskResponse.status(), 201);
  for (let index = 1; index <= 35; index += 1) assert.equal((await createTask(`Virtual row ${index}`)).status(), 201);
  await page.reload();
  await page.getByRole('grid', { name: 'Tasks' }).waitFor();
  await page.getByRole('row', { name: /Keyboard first task/ }).waitFor();
  await page.getByRole('row', { name: /Thai IME journey/ }).waitFor();
  const taskOne = await page.request.get(`${origin}/api/v1/workspaces/${workspaceId}/tasks/1`).then((response) => response.json());
  const tableAttributeSave = page.waitForResponse((response) => response.url().includes(`/api/v1/tasks/${taskOne.id}/attributes`) && response.request().method() === 'PATCH');
  await page.getByLabel('Effort for #1', { exact: true }).selectOption('large');
  assert.equal((await tableAttributeSave).status(), 200);
  const tableAttributes = await page.request.get(`${origin}/api/v1/tasks/${taskOne.id}/attributes`).then((response) => response.json());
  assert.equal(tableAttributes.attributes.find((item) => item.id === attribute.id).value, 'large');

  const grid = page.getByRole('grid', { name: 'Tasks' });
  await grid.focus();
  await page.keyboard.press('F2');
  const editTitle = page.getByRole('textbox', { name: 'Edit title for #1' });
  await editTitle.waitFor();
  await editTitle.fill('Cancelled inline edit');
  await page.keyboard.press('Escape');
  await assert.doesNotReject(page.getByRole('row', { name: /Keyboard first task/ }).waitFor());
  await grid.focus();
  await page.keyboard.press('Enter');
  const secondEdit = page.getByRole('textbox', { name: 'Edit title for #1' });
  await secondEdit.fill('Renamed by keyboard');
  await page.keyboard.press('Enter');
  await page.getByRole('row', { name: /Renamed by keyboard/ }).waitFor();
  await page.keyboard.press('Control+z');
  await page.getByRole('row', { name: /Keyboard first task/ }).waitFor();
  await page.keyboard.press('Control+Shift+z');
  await page.getByRole('row', { name: /Renamed by keyboard/ }).waitFor();

  await page.keyboard.press('Shift+ArrowDown');
  assert.equal(await page.getByRole('row', { selected: true }).count(), 2);
  for (let index = 0; index < 34; index += 1) await page.keyboard.press('Shift+ArrowDown');
  await page.getByText('36 selected').waitFor();
  const activeRowId = await grid.getAttribute('aria-activedescendant');
  assert.match(activeRowId, /task-row-/);
  const activeRow = page.locator(`#${activeRowId}`);
  await activeRow.waitFor();
  assert.equal(await grid.evaluate((element) => element === document.activeElement), true);
  const activeBounds = await activeRow.boundingBox();
  const tableBounds = await page.locator('.table-scroll').boundingBox();
  assert.ok(activeBounds.y + activeBounds.height > tableBounds.y && activeBounds.y < tableBounds.y + tableBounds.height);
  const bulkSave = page.waitForResponse((response) => response.url().includes(`/api/v1/workspaces/${workspaceId}/tasks/bulk`) && response.request().method() === 'POST');
  await page.getByLabel('Set status').selectOption(status.key);
  assert.equal((await bulkSave).status(), 200);
  await page.waitForFunction((statusKey) => document.querySelector('[aria-label="Status for #36"]')?.value === statusKey, status.key);
  const taskListRefresh = page.waitForResponse((response) => response.url().includes(`/api/v1/workspaces/${workspaceId}/tasks`) && response.request().method() === 'GET');
  const bulkAttributeSave = page.waitForResponse((response) => response.url().includes(`/api/v1/workspaces/${workspaceId}/tasks/bulk-attributes`) && response.request().method() === 'POST');
  await page.getByLabel('Set Effort').selectOption('small');
  assert.equal((await bulkAttributeSave).status(), 200);
  await taskListRefresh;
  await grid.focus();
  await page.keyboard.press('Home');
  await page.waitForFunction((statusKey) => document.querySelector('[aria-label="Status for #1"]')?.value === statusKey, status.key);
  await page.waitForFunction(() => document.querySelector('[aria-label="Effort for #2"]')?.value === 'small');
  const tableStatusSave = page.waitForResponse((response) => response.url().includes(`/api/v1/workspaces/${workspaceId}/tasks/1`) && response.request().method() === 'PATCH');
  await page.getByLabel('Status for #1', { exact: true }).selectOption('completed');
  assert.equal((await tableStatusSave).status(), 200);

  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.waitFor();
  const search = palette.getByRole('searchbox', { name: 'Search tasks and commands' });
  await search.fill('Thai IME journey');
  await page.keyboard.press('Enter');
  await page.getByRole('region', { name: 'Task #2' }).waitFor();
  const taskTwoBeforeSave = await page.request.get(`${origin}/api/v1/workspaces/${workspaceId}/tasks/2`).then((response) => response.json());
  await page.getByLabel('Status').selectOption(status.key);
  await page.getByLabel('Effort').selectOption('large');
  const taskSave = page.waitForResponse((response) => response.url().includes(`/api/v1/workspaces/${workspaceId}/tasks/2`) && response.request().method() === 'PATCH');
  const attributeSave = page.waitForResponse((response) => response.url().includes(`/api/v1/tasks/${taskTwoBeforeSave.id}/attributes`) && response.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Save changes' }).click();
  assert.equal((await taskSave).status(), 200);
  assert.equal((await attributeSave).status(), 200);
  const taskTwo = await page.request.get(`${origin}/api/v1/workspaces/${workspaceId}/tasks/2`).then((response) => response.json());
  assert.equal(taskTwo.status, status.key);
  const taskAttributes = await page.request.get(`${origin}/api/v1/tasks/${taskTwo.id}/attributes`).then((response) => response.json());
  assert.equal(taskAttributes.attributes.find((item) => item.id === attribute.id).value, 'large');

  await page.getByRole('link', { name: 'Open full page' }).click();
  await page.getByRole('button', { name: 'Back to list' }).click();
  await page.getByRole('grid', { name: 'Tasks' }).focus();
  await page.keyboard.press('Control+k');
  await page.getByRole('searchbox', { name: 'Search tasks and commands' }).fill('status Ready for review');
  const paletteStatusUpdate = page.waitForResponse((response) => response.url().includes(`/api/v1/workspaces/${workspaceId}/tasks/1`) && response.request().method() === 'PATCH');
  await page.keyboard.press('Enter');
  assert.equal((await paletteStatusUpdate).status(), 200);
  assert.equal((await page.request.get(`${origin}/api/v1/workspaces/${workspaceId}/tasks/1`).then((response) => response.json())).status, status.key);
  await page.keyboard.press('Control+k');
  await page.getByRole('searchbox', { name: 'Search tasks and commands' }).fill('create Palette-created task');
  await page.keyboard.press('Enter');
  await page.getByRole('region', { name: 'Task #38' }).waitFor();
  await page.getByRole('link', { name: 'Open full page' }).click();
  await page.getByRole('button', { name: 'Back to list' }).click();
  const shortcutsButton = page.getByRole('button', { name: 'Keyboard shortcuts' });
  await shortcutsButton.click();
  await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Keyboard shortcuts');
  await page.getByRole('grid', { name: 'Tasks' }).focus();
  await page.getByRole('button', { name: 'Browse mode' }).click();
  await page.getByRole('grid', { name: 'Tasks' }).focus();
  await page.keyboard.press('Tab');
  const beforeOutline = await page.request.get(`${origin}/api/v1/workspaces/${workspaceId}/tasks`).then((response) => response.json());
  assert.equal(beforeOutline.tasks.filter((item) => item.parent_task_id).length, 0);
  await page.getByRole('button', { name: 'Outline mode' }).click();
  await page.getByRole('grid', { name: 'Tasks' }).focus();
  await page.keyboard.press('Tab');
  const childRow = page.getByRole('row', { name: /New subtask/ });
  await childRow.waitFor();
  assert.equal(await childRow.locator('.table-task').evaluate((element) => getComputedStyle(element).paddingLeft), '40px');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'New subtask' }).waitFor();
  const inOutline = await page.request.get(`${origin}/api/v1/workspaces/${workspaceId}/tasks`).then((response) => response.json());
  assert.equal(inOutline.tasks.filter((item) => item.parent_task_id).length, 1);

  await page.getByRole('button', { name: 'Browse mode' }).click();
  await page.getByLabel('Task title').focus();
  await page.keyboard.press('e');
  assert.equal(await page.locator('[data-keyboard-mode]').getAttribute('data-keyboard-mode'), 'browse');
  await page.evaluate(() => {
    const input = document.activeElement;
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
  });
  await page.keyboard.press('o');
  await page.evaluate(() => {
    const input = document.activeElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'ภาษาไทย');
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'ภาษาไทย', inputType: 'insertCompositionText' }));
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'ภาษาไทย' }));
  });
  assert.equal(await page.locator('[data-keyboard-mode]').getAttribute('data-keyboard-mode'), 'browse');
  assert.equal(await page.getByLabel('Task title').inputValue(), 'ภาษาไทย');
  await page.keyboard.press('Control+k');
  await page.getByRole('dialog', { name: 'Command palette' }).waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.id === 'task-title');
  await page.getByRole('button', { name: 'New subtask' }).click();
  await page.getByRole('button', { name: 'Archive' }).click();
  const taskGrid = page.getByRole('grid', { name: 'Tasks' });
  await taskGrid.waitFor();
  await page.getByRole('row', { name: /New subtask/ }).waitFor({ state: 'detached' });
  const paletteTask = await page.request.get(`${origin}/api/v1/workspaces/${workspaceId}/tasks/38`).then((response) => response.json());
  assert.equal(await taskGrid.getAttribute('aria-activedescendant'), `task-row-${paletteTask.id}`);
  await context.close();
});
