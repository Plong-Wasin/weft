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

// Collaboration exit gate in real browsers: two members see the same state, and undo, after each
// visible action; and one person goes from writing a comment to approving a Proposal with the
// keyboard only, at phone width.

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const binary = resolve(appRoot, 'target/debug/weft');
const databaseUrl = process.env.WEFT_E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://weft:weft@127.0.0.1:55432/postgres';
const schema = `weft_collab_${randomUUID().replaceAll('-', '')}`;
const vaultRoot = `/tmp/weft-e2e-collab-vaults-${schema}`;
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
    await page.getByRole('button', { name: /Collaboration Workspace/ }).focus();
    await page.keyboard.press('Enter');
    await tasks.waitFor();
  }
}

async function createTask(data) {
  const response = await api.request.post(`${origin}/api/v1/workspaces/${workspaceId}/tasks`, { data: { project_id: projectId, ...data }, headers: { 'x-csrf-token': await csrfOf(api) } });
  assert.equal(response.status(), 201, await response.text());
  return response.json();
}

async function openTask(page, task) {
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.waitFor();
  await palette.getByRole('searchbox', { name: 'Search tasks and commands' }).fill(task.title);
  await palette.getByRole('option', { name: new RegExp(task.title) }).first().waitFor();
  await page.keyboard.press('Enter');
  await page.getByRole('region', { name: `Task #${task.number}` }).waitFor();
}

const waitForRequest = (page, part, method) => page.waitForResponse((response) => response.url().includes(part) && response.request().method() === method);

async function pressUndo(page) {
  const response = waitForRequest(page, `/workspaces/${workspaceId}/history/undo`, 'POST');
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await page.keyboard.press('Control+z');
  return response;
}

before(async () => {
  await access(binary);
  await access(resolve(appRoot, 'apps/web/dist/index.html'));
  psql(`CREATE SCHEMA ${schema}`);
  const scopedDatabaseUrl = `${databaseUrl}?options=-csearch_path%3D${schema}`;
  const env = { ...process.env, DATABASE_URL: scopedDatabaseUrl, WEFT_WEB_ROOT: resolve(appRoot, 'apps/web/dist'), WEFT_VAULT_ROOT: vaultRoot };
  run(binary, ['bootstrap-admin', ownerEmail, ownerPassword, 'Collaboration Workspace'], env);
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
  workspaceId = me.workspaces.find((item) => item.name === 'Collaboration Workspace').id;
  const csrf = await csrfOf(api);
  const project = await api.request.post(`${origin}/api/v1/workspaces/${workspaceId}/projects`, { data: { name: 'Collaboration project', visibility: 'workspace' }, headers: { 'x-csrf-token': csrf } });
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

test('two browsers show the same state after each visible action and after its undo', async () => {
  const [ownerContext, memberContext] = await Promise.all([browser.newContext(), browser.newContext()]);
  const [owner, member] = await Promise.all([ownerContext.newPage(), memberContext.newPage()]);
  owner.setDefaultTimeout(15000);
  member.setDefaultTimeout(15000);
  try {
    const related = await createTask({ title: 'Related gate task' });
    const shared = await createTask({ title: 'Shared gate task' });
    await signIn(owner, ownerEmail, ownerPassword);
    await signIn(member, memberEmail, memberPassword);
    await Promise.all([openTask(owner, shared), openTask(member, shared)]);
    const articles = (page, text) => page.locator('article.comment').filter({ hasText: text });

    // A Markdown comment with a Task reference and a mention appears in both browsers.
    const commentBox = owner.getByLabel('Markdown comment');
    await commentBox.fill(`Please review #${related.number} @member`);
    await owner.getByRole('listbox', { name: 'People to mention' }).waitFor();
    await commentBox.press('ArrowDown');
    await commentBox.press('Enter');
    assert.match(await commentBox.inputValue(), /@member@example\.com /);
    const posted = waitForRequest(owner, '/comments', 'POST');
    await owner.getByRole('button', { name: 'Comment', exact: true }).focus();
    await owner.keyboard.press('Enter');
    assert.equal((await posted).status(), 201);
    for (const page of [owner, member]) {
      await articles(page, 'Please review').waitFor();
      await articles(page, 'Please review').locator('a[data-task-reference="true"]').waitFor();
    }
    const inbox = () => member.request.get(`${origin}/api/v1/workspaces/${workspaceId}/inbox`).then((response) => response.text());
    assert.match(await inbox(), new RegExp(`"number":${shared.number}`), 'the mention reaches the Inbox of the other member');

    // A reaction toggles live and toggles back.
    const react = (page) => articles(page, 'Please review').getByRole('button', { name: /React to comment .* with thumbs up/ });
    await react(owner).focus();
    await owner.keyboard.press('Enter');
    await articles(member, 'Please review').locator('button').filter({ hasText: '👍 1' }).waitFor();
    await react(owner).focus();
    await owner.keyboard.press('Enter');
    await articles(member, 'Please review').locator('button').filter({ hasText: '👍 0' }).waitFor();

    // The other member replies; both screens show the reply.
    await articles(member, 'Please review').getByRole('button', { name: 'Reply' }).focus();
    await member.keyboard.press('Enter');
    await member.getByLabel('Markdown comment').fill('Seen, thanks');
    await member.getByRole('button', { name: 'Reply', exact: true }).last().focus();
    const replied = waitForRequest(member, '/comments', 'POST');
    await member.keyboard.press('Enter');
    assert.equal((await replied).status(), 201);
    for (const [name, page] of [['owner', owner], ['member', member]]) await articles(page, 'Seen, thanks').waitFor().catch(async (error) => { await page.screenshot({ path: `/tmp/claude-1000/gate-${name}.png`, fullPage: true }); throw error; });

    // A title change shows live in the other browser and undo reverts it in both.
    await owner.getByLabel('Title', { exact: true }).fill('Shared gate task renamed');
    const saved = waitForRequest(owner, `/api/v1/workspaces/${workspaceId}/tasks/${shared.number}`, 'PATCH');
    await owner.getByRole('button', { name: 'Save changes' }).click();
    assert.equal((await saved).status(), 200);
    const titleIs = (expected) => [...document.querySelectorAll('input')].some((input) => input.value === expected);
    await member.waitForFunction(titleIs, 'Shared gate task renamed');
    assert.equal((await pressUndo(owner)).status(), 200);
    await member.waitForFunction(titleIs, 'Shared gate task');

    // Turning the reply into a Task shows the link in both browsers; undo removes it in both.
    await articles(owner, 'Seen, thanks').getByRole('button', { name: 'Create Task', exact: true }).focus();
    await owner.keyboard.press('Enter');
    const form = owner.getByRole('form', { name: 'Create Task from comment' });
    await form.getByLabel('Title').fill('Task from the shared reply');
    await form.getByRole('button', { name: 'Save Task' }).focus();
    const created = waitForRequest(owner, '/create-task', 'POST');
    await owner.keyboard.press('Enter');
    assert.equal((await created).status(), 201);
    await owner.getByRole('button', { name: 'Back to list' }).or(owner.getByRole('button', { name: 'Close task' })).first().waitFor();
    await openTask(owner, shared);
    for (const page of [owner, member]) await articles(page, 'Seen, thanks').getByRole('link', { name: /Created Task: #/ }).waitFor();
    const undoCreate = await pressUndo(owner);
    assert.equal(undoCreate.status(), 200, await undoCreate.text());
    for (const page of [owner, member]) await articles(page, 'Seen, thanks').getByRole('link', { name: /Created Task: #/ }).waitFor({ state: 'detached' });

    // Deleting the comment removes it from the other browser and drops its Inbox mention.
    const commentId = (await owner.request.get(`${origin}/api/v1/tasks/${shared.id}/comments`).then((response) => response.json())).comments.find((item) => item.body.startsWith('Please review')).id;
    const byId = (page) => page.locator(`article.comment[data-comment-id="${commentId}"]`);
    await byId(owner).getByRole('button', { name: 'Delete' }).focus();
    await owner.keyboard.press('Enter');
    await byId(member).waitFor({ state: 'detached' });
    assert.doesNotMatch(await inbox(), /Please review/, 'the Inbox never shows deleted text');
  } finally {
    await Promise.all([ownerContext.close(), memberContext.close()]);
  }
});

test('the journey from writing a comment to approving a Proposal works with the keyboard at phone width', async () => {
  const target = await createTask({ title: 'Phone target task' });
  const task = await createTask({ title: 'Phone writing task' });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  try {
    await signIn(page, ownerEmail, ownerPassword);
    await openTask(page, task);
    const noScroll = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal scroll');
    await noScroll();
    const commentBox = page.getByLabel('Markdown comment');
    await commentBox.fill(`Phone note #${target.number}`);
    await page.getByRole('listbox', { name: 'Task references' }).waitFor();
    await commentBox.press('ArrowDown');
    await commentBox.press('Enter');
    const posted = waitForRequest(page, '/comments', 'POST');
    await page.getByRole('button', { name: 'Comment', exact: true }).focus();
    await page.keyboard.press('Enter');
    assert.equal((await posted).status(), 201);
    const comment = page.locator('article.comment').filter({ hasText: 'Phone note' });
    await comment.locator('a[data-task-reference="true"]').waitFor();
    await noScroll();
    const small = await comment.locator('button').evaluateAll((controls) => controls.map((control) => ({ name: control.textContent?.trim(), ...control.getBoundingClientRect().toJSON() })).filter((control) => control.width > 0 && control.height < 44).map(({ name, height }) => ({ name, height })));
    assert.deepEqual(small, [], 'discussion controls are at least 44 pixels tall');
    await comment.getByRole('button', { name: /React to comment .* with thumbs up/ }).focus();
    await page.keyboard.press('Enter');
    await comment.locator('button').filter({ hasText: '👍 1' }).waitFor();

    // Inbox, then the Proposal: create, review and approve with the keyboard.
    await page.getByRole('button', { name: 'Close task' }).focus();
    await page.keyboard.press('Enter');
    const primary = page.getByRole('navigation', { name: 'Primary' });
    await primary.getByRole('button', { name: 'Inbox' }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'Inbox', level: 2 }).waitFor();
    await noScroll();
    await primary.getByRole('button', { name: /Proposal/ }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Create mock Proposal' }).focus();
    await page.keyboard.press('Enter');
    const approve = page.getByRole('button', { name: 'Approve' });
    await approve.waitFor();
    await approve.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('status').getByText(/approved/i).waitFor();
    await noScroll();
  } finally {
    await context.close();
  }
});
