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
const schema = `weft_keyboard_${randomUUID().replaceAll('-', '')}`;
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

test('keyboard users can edit tasks, use the palette, undo changes, and type Thai safely', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(origin);
  await page.getByLabel('Email').fill('owner@example.com');
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Choose a Workspace' }).waitFor();
  await page.getByRole('button', { name: /Keyboard Workspace/ }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
  const secondaryContext = await browser.newContext();
  const secondaryPage = await secondaryContext.newPage();
  await secondaryPage.goto(origin);
  await secondaryPage.getByLabel('Email').fill('owner@example.com');
  await secondaryPage.getByLabel('Password').fill(password);
  await secondaryPage.getByRole('button', { name: 'Sign in' }).click();
  await secondaryPage.getByRole('heading', { name: 'Choose a Workspace' }).waitFor();
  await secondaryPage.getByRole('button', { name: /Keyboard Workspace/ }).focus();
  await secondaryPage.keyboard.press('Enter');
  await secondaryPage.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();

  const me = await page.request.get(`${origin}/api/v1/auth/me`).then((response) => response.json());
  workspaceId = me.workspaces[0].id;
  await page.getByLabel('New Project name').fill('Keyboard project');
  await page.getByRole('button', { name: 'Create Project' }).click();
  await page.getByLabel('Project', { exact: true }).selectOption({ label: 'Keyboard project' });
  const projectId = await page.getByLabel('Project', { exact: true }).inputValue();

  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Statuses', exact: true }).click();
  await page.getByLabel('New Status name').fill('Ready for review');
  await page.getByLabel('New Status category').selectOption('active');
  await page.getByRole('button', { name: 'Create Status' }).click();
  await page.getByText('Status created.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Attributes', exact: true }).click();
  await page.getByLabel('New Attribute name').fill('Effort');
  await page.getByLabel('New Attribute type').selectOption('single_select');
  await page.getByLabel('Attribute options').fill('Small, Large');
  await page.getByLabel('Keyboard project').check();
  await page.getByRole('button', { name: 'Create Attribute' }).click();
  await page.getByText('Attribute created.', { exact: true }).waitFor();
  const schema = await page.request.get(`${origin}/api/v1/workspaces/${workspaceId}/attributes`).then((response) => response.json());
  const attribute = schema.attributes.find((item) => item.name === 'Effort');
  assert.deepEqual(attribute.options.map((item) => item.name), ['Small', 'Large']);
  const statusSchema = await page.request.get(`${origin}/api/v1/workspaces/${workspaceId}/statuses`).then((response) => response.json());
  const status = statusSchema.statuses.find((item) => item.name === 'Ready for review');
  assert.ok(status);
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();

  const createTaskInUi = async (taskTitle) => {
    await page.getByLabel('Task title').fill(taskTitle);
    await page.getByRole('button', { name: 'Create task' }).click();
    const close = page.getByRole('button', { name: 'Close task' });
    await close.waitFor();
    await close.click();
  };
  await createTaskInUi('Keyboard first task');
  await createTaskInUi('Thai IME journey');
  for (let index = 1; index <= 35; index += 1) await createTaskInUi(`Virtual row ${index}`);
  const taskOne = await page.request.get(`${origin}/api/v1/workspaces/${workspaceId}/tasks/1`).then((response) => response.json());
  const attributeList = await page.request.get(`${origin}/api/v1/workspaces/${workspaceId}/attributes`).then((response) => response.json());
  assert.deepEqual(attributeList.attributes.find((item) => item.id === attribute.id).options.map((item) => item.name), ['Small', 'Large']);
  await page.getByRole('grid', { name: 'Tasks' }).waitFor();
  await page.getByRole('row', { name: /Keyboard first task/ }).waitFor();
  await page.getByRole('row', { name: /Thai IME journey/ }).waitFor();
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
  await page.getByRole('button', { name: 'More', exact: true }).focus();
  await page.keyboard.press('Enter');
  const settingsMore = page.getByRole('dialog', { name: 'More' });
  await settingsMore.getByRole('button', { name: 'Settings' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Active sessions' }).waitFor();
  await page.getByText('This device', { exact: true }).waitFor();
  const otherSessions = page.locator('.settings-list > li').filter({ hasText: 'Signed-in device' });
  while (await otherSessions.count()) {
    const countBeforeRevoke = await otherSessions.count();
    await otherSessions.first().getByRole('button', { name: 'Revoke' }).click();
    await page.waitForFunction((count) => [...document.querySelectorAll('.settings-list > li')].filter((row) => row.textContent?.includes('Signed-in device')).length < count, countBeforeRevoke);
  }
  await secondaryContext.close();
  await page.getByRole('button', { name: 'More', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('dialog', { name: 'More' }).getByRole('button', { name: 'Sign out' }).focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('Email').waitFor();
  await context.close();
});

test('mobile users can navigate by bottom tabs, open the command sheet, and get clear offline write feedback', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(origin);
  await page.getByLabel('Email').fill('owner@example.com');
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Choose a Workspace' }).waitFor();
  await page.getByRole('button', { name: /Keyboard Workspace/ }).click();
  await page.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();

  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  });
  await page.reload();
  await page.getByRole('navigation', { name: 'Primary' }).waitFor();

  const tabs = page.getByRole('navigation', { name: 'Primary' });
  const manifest = await page.request.get(`${origin}/manifest.webmanifest`).then((response) => response.json());
  assert.equal(manifest.display, 'standalone');
  assert.ok(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), 'PWA service worker should control the installed app');
  await tabs.waitFor();
  for (const label of ['Inbox', 'My work', 'Proposal', 'Knowledge', 'More']) {
    const tab = tabs.getByRole('button', { name: label, exact: true });
    await tab.waitFor();
    const bounds = await tab.boundingBox();
    assert.ok(bounds.height >= 44, `${label} tab should have a comfortable touch target`);
    assert.ok(bounds.width >= 44, `${label} tab should have a comfortable touch target`);
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'phone layout should not overflow horizontally');
  await tabs.getByRole('button', { name: 'Inbox', exact: true }).click();
  const taskButton = page.getByRole('button', { name: 'Thai IME journey' });
  await taskButton.click();
  const panel = page.getByRole('region', { name: 'Task #2' });
  await panel.waitFor();
  const panelBounds = await panel.boundingBox();
  assert.ok(panelBounds.width >= 380, 'task panel should use the phone width');
  assert.ok(await panel.getByRole('button', { name: 'Save changes' }).evaluate((button) => button.getBoundingClientRect().height >= 44), 'task actions should have touch-sized targets');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.textContent?.includes('Thai IME journey'));

  const csrf = (await context.cookies(origin)).find((cookie) => cookie.name === 'weft_csrf')?.value;
  const workspaceId = await page.request.get(`${origin}/api/v1/auth/me`).then((response) => response.json()).then((me) => me.workspaces[0].id);
  const vaultCreate = await page.request.post(`${origin}/api/v1/workspaces/${workspaceId}/vaults`, { data: { name: 'Phone knowledge', visibility: 'workspace' }, headers: { 'x-csrf-token': csrf } });
  assert.equal(vaultCreate.status(), 201);
  const phoneVault = await vaultCreate.json();
  await tabs.getByRole('button', { name: 'Proposal', exact: true }).click();
  await page.getByRole('button', { name: 'Create mock Proposal' }).waitFor();
  await page.getByRole('button', { name: 'Create mock Proposal' }).click();
  const proposalReview = page.getByRole('region', { name: 'Proposal review' });
  await proposalReview.waitFor();
  for (const kind of ['Tasks', 'Links', 'Knowledge', 'Skills', 'Schema']) {
    await proposalReview.getByRole('heading', { name: new RegExp(kind) }).waitFor();
  }
  await proposalReview.getByText('0 of 1 kept', { exact: false }).waitFor();
  assert.equal(await proposalReview.getByLabel('Add Proposal review.md').isDisabled(), true, 'Vault items stay review-only until the API supports applying them');
  await proposalReview.getByText('2 of 2 kept', { exact: false }).waitFor();
  await proposalReview.getByRole('button', { name: 'Show details' }).first().click();
  await proposalReview.getByText('Created from the mock provider.').waitFor();
  await proposalReview.getByRole('button', { name: 'Hide details' }).click();
  const parentItem = proposalReview.getByLabel('Keep Prepare the launch checklist');
  const dependencyUpdate = page.waitForResponse((response) => response.url().includes('/proposals/') && response.request().method() === 'PATCH');
  await parentItem.focus();
  await page.keyboard.press('Space');
  const dependencyResponse = await dependencyUpdate;
  assert.equal(dependencyResponse.status(), 200, await dependencyResponse.text());
  await page.getByRole('status').getByText(/dependent item removed/i).waitFor();
  await proposalReview.getByText('0 of 2 kept', { exact: false }).waitFor();
  const dependent = proposalReview.getByLabel('Add dependent task');
  const dependencyRestore = page.waitForResponse((response) => response.url().includes('/proposals/') && response.request().method() === 'PATCH');
  await dependent.focus();
  await page.keyboard.press('Space');
  const restoreResponse = await dependencyRestore;
  assert.equal(restoreResponse.status(), 200, await restoreResponse.text());
  await proposalReview.getByText('2 of 2 kept', { exact: false }).waitFor();
  const csrfProposal = (await context.cookies(origin)).find((cookie) => cookie.name === 'weft_csrf')?.value;
  const skills = await page.request.get(`${origin}/api/v1/workspaces/${workspaceId}/skills`).then((response) => response.json());
  const skill = skills.skills.find((item) => item.name === 'How this Workspace works');
  const skillChange = await page.request.patch(`${origin}/api/v1/workspaces/${workspaceId}/skills/${skill.id}`, { data: { expected_version: skill.version, body: 'Changed after Proposal creation.' }, headers: { 'x-csrf-token': csrfProposal } });
  assert.equal(skillChange.status(), 200);
  await proposalReview.getByRole('button', { name: 'Check versions' }).click();
  await proposalReview.getByText(/Stale item: stale base version/i).waitFor();
  assert.equal(await proposalReview.getByRole('button', { name: 'Approve' }).isDisabled(), true);
  await proposalReview.getByRole('button', { name: 'Refresh stale Skills' }).click();
  await proposalReview.getByText(/Stale Skill refreshed/i).waitFor();
  await proposalReview.getByText('Current Skill').waitFor();
  await proposalReview.getByText('Changed after Proposal creation.').waitFor();
  await proposalReview.getByRole('button', { name: 'Approve' }).waitFor();
  assert.equal(await proposalReview.getByRole('button', { name: 'Approve' }).isEnabled(), true);
  await proposalReview.getByRole('button', { name: 'Approve' }).focus();
  assert.equal(await proposalReview.getByRole('button', { name: 'Approve' }).evaluate((button) => button === document.activeElement), true, 'Approve should be keyboard focusable');
  await page.route('**/proposals/*/approve', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });
  await proposalReview.getByRole('button', { name: 'Approve' }).click();
  await page.getByRole('dialog', { name: 'Applying Proposal' }).getByText(/briefly locking/i).waitFor();
  await proposalReview.getByRole('status').getByText(/Proposal approved/i).waitFor();
  await page.unroute('**/proposals/*/approve');
  await proposalReview.getByRole('button', { name: 'Undo' }).click();
  await proposalReview.getByRole('status').getByText(/Proposal changes undone/i).waitFor();
  const knowledgeTab = tabs.getByRole('button', { name: 'Knowledge', exact: true });
  await knowledgeTab.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Knowledge', level: 1 }).waitFor();
  const openVault = page.getByRole('button', { name: 'Open Vault Phone knowledge' });
  await openVault.focus();
  assert.equal(await openVault.evaluate((button) => button === document.activeElement), true, 'Vault list entries should be keyboard focusable at phone width');
  await page.keyboard.press('Enter');
  await page.getByText('No files in this Vault yet.').waitFor();
  await page.getByRole('status').getByText(/Content is not yet searchable/i).waitFor();
  assert.equal(await page.getByRole('navigation', { name: 'Vault notes' }).locator('button').count(), 0);
  assert.equal(await page.locator('textarea').count(), 0, 'Knowledge reading must not expose a Markdown editor');
  const noteRoot = `/tmp/weft-e2e-knowledge-${schema}`;
  const noteArchive = `${noteRoot}.tar.gz`;
  run('mkdir', ['-p', noteRoot]);
  await writeFile(`${noteRoot}/Thai Search Note.md`, '---\ntags: [guide]\n---\n# Thai Search Note\n\nระบบจัดการงานทีม ลับเฉพาะเนื้อหา\n\nSee [[Target Note]].');
  await writeFile(`${noteRoot}/Target Note.md`, '# Target Note\n\nKeyboard navigation target.');
  run('tar', ['-czf', noteArchive, '-C', noteRoot, '.']);
  const importResponse = await page.request.post(`${origin}/api/v1/vaults/${phoneVault.id}/imports/archive`, {
    data: await readFile(noteArchive),
    headers: { 'content-type': 'application/gzip', 'x-csrf-token': csrf },
  });
  assert.equal(importResponse.status(), 202);
  const importJob = await importResponse.json();
  let importStatus;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await page.request.get(`${origin}/api/v1/vaults/${phoneVault.id}/imports/${importJob.id}`).catch(() => null);
    if (response?.ok()) {
      importStatus = await response.json();
      if (importStatus.status === 'completed' || importStatus.status === 'failed') break;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  assert.equal(importStatus?.status, 'completed');
  const knowledgeSearch = page.getByRole('searchbox', { name: 'Search Knowledge notes' });
  await knowledgeSearch.fill('จัดการ');
  const searchNotes = page.getByRole('button', { name: 'Search notes' });
  await searchNotes.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: '1 note results' }).waitFor();
  const noteResult = page.getByRole('button', { name: /Thai Search Note/ }).first();
  await noteResult.focus();
  assert.equal(await noteResult.evaluate((button) => button === document.activeElement), true, 'Knowledge search results should be keyboard focusable at phone width');
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Thai Search Note', level: 3 }).waitFor();
  const readerLink = page.getByRole('link', { name: 'Target Note' });
  await readerLink.focus();
  assert.equal(await readerLink.evaluate((link) => link === document.activeElement), true, 'Rendered links in the Knowledge reader should be keyboard focusable at phone width');
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Target Note', level: 3 }).waitFor();
  const knowledgePaletteButton = page.getByRole('button', { name: 'Open command palette' });
  await knowledgePaletteButton.click();
  const paletteSearch = page.getByRole('searchbox', { name: 'Search tasks and commands' });
  await paletteSearch.fill('ลับเฉพาะเนื้อหา');
  await page.getByText('No matching tasks or note names.').waitFor();
  await paletteSearch.fill('Thai Search Note');
  await page.getByRole('option', { name: /Thai Search Note/ }).waitFor();
  await page.getByRole('option', { name: /Thai Search Note/ }).click();
  await page.getByRole('heading', { name: 'Thai Search Note', level: 3 }).waitFor();
  await rm(noteRoot, { recursive: true, force: true });
  await rm(noteArchive, { force: true });
  const moreButton = tabs.getByRole('button', { name: 'More', exact: true });
  await moreButton.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('dialog', { name: 'More' }).waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.textContent === 'More');

  const paletteButton = page.getByRole('button', { name: 'Open command palette' });
  await paletteButton.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('dialog', { name: 'Command palette' }).waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Open command palette');

  await page.context().setOffline(true);
  await page.reload();
  await page.getByRole('navigation', { name: 'Primary' }).waitFor();
  await page.getByRole('row', { name: /Thai IME journey/ }).waitFor();
  await tabs.getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.getByLabel('Task title').fill('Offline attempt');
  await page.getByRole('button', { name: 'Create task' }).click();
  await page.getByRole('alert').getByText(/offline.*read-only|read-only.*offline/i).waitFor();

  await page.context().setOffline(false);
  await page.getByRole('button', { name: 'More', exact: true }).focus();
  await page.keyboard.press('Enter');
  const moreDialog = page.getByRole('dialog', { name: 'More' });
  await moreDialog.getByRole('button', { name: 'Settings' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Active sessions' }).waitFor();
  await page.getByText('This device', { exact: true }).waitFor();
  const otherSessions = page.locator('.settings-list > li').filter({ hasText: 'Signed-in device' });
  while (await otherSessions.count()) {
    const countBeforeRevoke = await otherSessions.count();
    const otherSession = otherSessions.first();
    await otherSession.getByRole('button', { name: 'Revoke' }).click();
    await page.waitForFunction((count) => [...document.querySelectorAll('.settings-list > li')].filter((row) => row.textContent?.includes('Signed-in device')).length < count, countBeforeRevoke);
  }

  const settingsNav = page.getByRole('navigation', { name: 'Settings sections' });
  await settingsNav.getByRole('button', { name: 'Statuses' }).focus();
  await page.keyboard.press('Enter');
  const statusName = page.getByLabel('Name for Ready for review');
  await statusName.fill('Ready for review renamed');
  await statusName.press('Tab');
  await page.getByLabel('Category for Ready for review renamed').selectOption('completed');
  await page.getByLabel('Color for Ready for review renamed').fill('#2060a0');
  await page.getByRole('button', { name: 'Move Ready for review renamed up' }).click();
  await page.getByLabel('New Status name').fill('Temporary status');
  await page.getByRole('button', { name: 'Create Status' }).click();
  const archiveStatusRow = page.locator('.settings-list > li').filter({ has: page.getByLabel('Name for Temporary status') });
  await archiveStatusRow.getByRole('button', { name: 'Archive', exact: true }).click();
  await page.getByText(/This affects 0 tasks and 0 views/).waitFor();
  await page.getByLabel('Replacement Status').selectOption({ label: 'Backlog' });
  await page.getByRole('button', { name: 'Confirm archive' }).click();

  await settingsNav.getByRole('button', { name: 'Attributes' }).focus();
  await page.keyboard.press('Enter');
  const smallOption = page.getByLabel('Rename option Small');
  await smallOption.fill('Tiny');
  await smallOption.press('Tab');
  await page.getByRole('button', { name: 'Add option' }).first().click();
  await page.getByLabel('New option name').fill('Extra large');
  await page.getByRole('button', { name: 'Save option' }).click();
  await page.getByRole('button', { name: 'Archive option' }).first().click();
  await page.getByLabel('New Attribute name').fill('Temporary schema');
  await page.getByRole('button', { name: 'Create Attribute' }).click();
  await page.getByText('Attribute created.', { exact: true }).waitFor();
  const archiveAttributeRow = page.locator('.settings-list > li').filter({ has: page.getByLabel('Name for Temporary schema') });
  await archiveAttributeRow.getByRole('button', { name: 'Archive Attribute' }).click();
  await archiveAttributeRow.getByText(/^This affects \d+ saved views\.$/).waitFor();
  await archiveAttributeRow.getByRole('button', { name: 'Confirm archive' }).click();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByLabel('Email').waitFor();
  await context.close();
});
