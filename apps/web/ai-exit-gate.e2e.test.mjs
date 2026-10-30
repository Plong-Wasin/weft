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

// Exit-gate journeys in a real browser with a scripted provider: a keyboard-only desktop journey
// from connecting team AI to undoing the approved group, and a phone-viewport journey driven by
// keyboard and touch. The runner below speaks the same outbound protocol as the real bridge.

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const binary = resolve(appRoot, 'target/debug/weft');
const databaseUrl = process.env.WEFT_E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://weft:weft@127.0.0.1:55432/postgres';
const schema = `weft_gate_${randomUUID().replaceAll('-', '')}`;
const vaultRoot = `/tmp/weft-e2e-gate-vaults-${schema}`;
const password = 'ai journey password';
let connectionId;
let server;
let browser;
let origin;
let runnerStop = false;
let runnerLoop;

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

const sleep = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

function plan(prompt, project) {
  const task = (id, title, extra = {}) => ({ id, kind: 'task', project_id: project, title, description: `${title}: drafted by the scripted provider.`, reason: `The request asks for ${title.toLowerCase()}.`, sources: [], ...extra });
  const regenerate = prompt.match(/^Propose (\d+) replacement/m);
  if (regenerate) {
    const items = Array.from({ length: Number(regenerate[1]) }, (_, index) => task(`tmp-redo-${index}`, `Regenerated row ${index + 1}`));
    return { items, assumptions: [], open_questions: [] };
  }
  return {
    items: [
      task('tmp-api', 'Build the subscription API', { acceptance_criteria: ['Plans can be listed', 'Invoices are issued'], attributes: { Effort: 'Large' }, guesses: { assignees: ['Somchai'], due_date: '2026-12-01' } }),
      task('tmp-web', 'Build the subscription web screens', { depends_on: ['tmp-api'] }),
      task('tmp-qa', 'Run QA and UAT', { depends_on: ['tmp-web'] }),
      task('tmp-notes', 'Write the launch notes'),
      { id: 'tmp-blocks', kind: 'relation', relation: 'blocks', source_task_id: 'tmp-api', target_task_id: 'tmp-qa', reason: 'QA waits for the API.', sources: [] },
    ],
    assumptions: ['The existing billing provider stays'],
    open_questions: ['Who signs off UAT?'],
  };
}

async function startScriptedRunner(page) {
  const csrf = (await page.context().cookies(origin)).find((cookie) => cookie.name === 'weft_csrf')?.value;
  const code = await page.request.post(`${origin}/api/v1/ai/connections/${connectionId}/runners/pairing-codes`, { data: {}, headers: { 'x-csrf-token': csrf } }).then((response) => response.json());
  const paired = await fetch(`${origin}/api/v1/ai/agent/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code.code, name: 'scripted', version: 'e2e', supported_modes: ['scripted'] }) }).then((response) => response.json());
  const headers = { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' };
  const post = (path, body) => fetch(`${origin}/api/v1/ai/agent/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  runnerLoop = (async () => {
    while (!runnerStop) {
      try {
        await post('heartbeat', {});
        const leased = await post('jobs/lease', {}).then((response) => response.json());
        if (leased.job) {
          const { payload } = leased.job;
          const body = plan(payload.arguments[0], payload.scope.projects[0]);
          await post(`jobs/${leased.job.id}/result`, { result: { summary: 'Drafted a plan from your goal', outcome: 'waiting_for_approval', proposal: { schema_version: 1, ...body }, tool_activity: [{ tool: 'search', truncated: true }] } });
          continue;
        }
      } catch { /* the server is shutting down */ }
      await sleep(200);
    }
  })();
}

before(async () => {
  await access(binary);
  await access(resolve(appRoot, 'apps/web/dist/index.html'));
  psql(`CREATE SCHEMA ${schema}`);
  const scopedDatabaseUrl = `${databaseUrl}?options=-csearch_path%3D${schema}`;
  const env = { ...process.env, DATABASE_URL: scopedDatabaseUrl, WEFT_WEB_ROOT: resolve(appRoot, 'apps/web/dist'), WEFT_VAULT_ROOT: vaultRoot, WEFT_AGENT_SIGNING_KEY: 'e2e-runner-signing-key-0123456789012345678901234567' };
  run(binary, ['bootstrap-admin', 'owner@example.com', password, 'AI Workspace'], env);
  const port = await unusedPort();
  origin = `http://127.0.0.1:${port}`;
  server = spawn(binary, ['serve'], { cwd: appRoot, env: { ...env, WEFT_LISTEN: `127.0.0.1:${port}` }, stdio: 'ignore' });
  browser = await chromium.launch({ headless: true, ...(process.env.WEFT_CHROMIUM_PATH ? { executablePath: process.env.WEFT_CHROMIUM_PATH } : {}) });
  const probe = await browser.newPage();
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await probe.request.get(`${origin}/health/ready`).catch(() => null))?.ok()) break;
    await sleep(50);
  }
  await probe.close();
});

after(async () => {
  runnerStop = true;
  await runnerLoop;
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
  await page.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
}

async function tabTo(page, name) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if (await page.evaluate((label) => (document.activeElement?.textContent ?? '').trim() === label || document.activeElement?.getAttribute('aria-label') === label, name)) return;
    await page.keyboard.press('Tab');
  }
  assert.fail(`Tab never reached ${name}`);
}

async function workspaceTasks(page, workspaceId) {
  return (await page.request.get(`${origin}/api/v1/workspaces/${workspaceId}/tasks`).then((response) => response.json())).tasks.map((item) => item.title);
}


async function csrfOf(page) {
  return (await page.context().cookies(origin)).find((cookie) => cookie.name === 'weft_csrf')?.value;
}

// Connect team AI through the real admin API: a Workspace connection is granted to the Workspace
// when it is created; then make it the default.
async function connectTeamAi(page, workspaceId) {
  const headers = { 'x-csrf-token': await csrfOf(page) };
  const created = await page.request.post(`${origin}/api/v1/ai/connections`, { headers, data: { scope: 'workspace', workspace_id: workspaceId, provider: 'scripted', auth_mode: 'api_key', billing_mode: 'api', capabilities: ['generate', 'split', 'link'], limits: {} } });
  assert.equal(created.status(), 201, await created.text());
  const connection = await created.json();
  assert.equal(connection.state, 'ready');
  assert.equal((await page.request.put(`${origin}/api/v1/ai/defaults`, { headers, data: { scope: 'workspace', workspace_id: workspaceId, connection_id: connection.id } })).ok(), true);
  return connection.id;
}

// Focus a control and confirm it kept focus: a re-render right after a state change can steal it.
async function focusByLabel(page, locator) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await locator.focus();
    if (await locator.evaluate((element) => element === document.activeElement)) return;
    await page.waitForTimeout(100);
  }
  assert.fail('control did not keep focus');
}

test('keyboard-only desktop journey: connect team AI, generate, edit rows, approve, read attributed history, undo the group', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(origin);
  await page.getByLabel('Email').fill('owner@example.com');
  await page.getByLabel('Password').fill(password);
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
  const me = await page.request.get(`${origin}/api/v1/auth/me`).then((response) => response.json());
  const workspaceId = me.workspaces[0].id;
  connectionId = await connectTeamAi(page, workspaceId);
  await startScriptedRunner(page);

  // Project from the keyboard, then see team AI in Settings.
  await page.reload();
  await page.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
  await page.getByLabel('New Project name').fill('Subscription');
  const [projectResponse] = await Promise.all([page.waitForResponse((response) => response.request().method() === 'POST' && /\/projects$/.test(response.url())), page.keyboard.press('Enter')]);
  assert.equal(projectResponse.status(), 201);
  await page.getByLabel('Project', { exact: true }).selectOption({ label: 'Subscription' });
  await page.getByText(/AI planning is ready/).waitFor();
  await focusByLabel(page, page.getByRole('button', { name: 'More', exact: true }));
  await page.keyboard.press('Enter');
  await page.getByRole('dialog', { name: 'More' }).waitFor();
  await page.waitForFunction(() => document.activeElement?.closest('[role="dialog"]'));
  await focusByLabel(page, page.getByRole('dialog', { name: 'More' }).getByRole('button', { name: 'Settings' }));
  await page.keyboard.press('Enter');
  const nav = page.getByRole('navigation', { name: 'Settings sections' });
  await focusByLabel(page, nav.getByRole('button', { name: 'Team AI' }));
  await page.keyboard.press('Enter');
  await page.getByRole('region', { name: 'Team AI' }).getByText(/Ready: members can generate without signing in to the provider/).waitFor();
  await page.keyboard.press('Escape');

  // Generate with AI from the palette.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+k');
  await page.waitForFunction(() => document.activeElement?.id === 'command-search');
  await page.keyboard.type('generate Open work for the subscription system');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Generate with AI' });
  await dialog.waitFor();
  await tabTo(page, 'Generate plan');
  await page.keyboard.press('Enter');
  const review = page.getByRole('region', { name: 'Proposal review' });
  await review.getByLabel('Keep Build the subscription API').waitFor();

  // Edit: rename a row, reject another, all by keyboard.
  const rows = review.locator('.proposal-group[aria-label="Tasks proposal items"] li');
  await focusByLabel(page, rows.filter({ hasText: 'Build the subscription API' }).getByRole('button', { name: 'Show details' }));
  await page.keyboard.press('Enter');
  await review.getByLabel('Title for Build the subscription API').fill('Build the billing API');
  await page.keyboard.press('Tab');
  await page.getByRole('status').getByText('Edit saved.').waitFor();
  await focusByLabel(page, rows.filter({ hasText: 'Write the launch notes' }).getByRole('button', { name: 'Show details' }));
  await page.keyboard.press('Enter');
  await focusByLabel(page, review.getByRole('button', { name: 'Reject Write the launch notes' }));
  await page.keyboard.press('Enter');
  await review.getByText('Rejected: Write the launch notes.').waitFor();

  // Approve: nothing existed before the keystroke.
  assert.deepEqual((await workspaceTasks(page, workspaceId)).filter((title) => /billing|QA|web screens/.test(title)), []);
  await focusByLabel(page, review.getByRole('button', { name: 'Approve' }));
  await page.keyboard.press('Enter');
  await review.getByRole('status').getByText(/Proposal approved/).waitFor();
  const listed = await page.request.get(`${origin}/api/v1/workspaces/${workspaceId}/tasks`).then((response) => response.json());
  const billing = listed.tasks.find((item) => item.title === 'Build the billing API');
  assert.ok(billing, 'the approved plan created the renamed Task');
  assert.equal(listed.tasks.some((item) => item.title === 'Write the launch notes'), false);

  // Attributed history: the approver is the actor and the AI run, provider and Proposal are the source.
  const history = await page.request.get(`${origin}/api/v1/tasks/${billing.id}/history`).then((response) => response.json());
  const groups = JSON.stringify(history);
  assert.match(groups, /ai_proposal/);
  assert.match(groups, /scripted/);
  assert.ok(history.operations.length > 0 && history.operations.every((operation) => operation.actor_id === me.user_id), 'the signed-in approver is named as the actor of every change');

  // Undo the whole group from the keyboard.
  await focusByLabel(page, review.getByRole('button', { name: 'Undo' }));
  await page.keyboard.press('Enter');
  await review.getByRole('status').getByText(/Proposal changes undone/).waitFor();
  const after = await workspaceTasks(page, workspaceId);
  assert.equal(after.some((title) => /billing|QA|web screens/.test(title)), false, 'every generated Task is gone in one undo');
  await context.close();
});

test('phone-viewport journey: review and approve an AI plan with the keyboard, with touch-sized targets', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await signIn(page);
  await page.getByText(/AI planning is ready/).waitFor();
  await page.getByLabel('Task title').fill('Phone plan for the subscription system');
  await focusByLabel(page, page.getByRole('button', { name: 'Generate with AI' }));
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Generate with AI' });
  await dialog.waitFor();
  await tabTo(page, 'Generate plan');
  await page.keyboard.press('Enter');
  const review = page.getByRole('region', { name: 'Proposal review' });
  await review.getByLabel('Keep Build the subscription API').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal scroll');

  // Every control a person has to hit in the review is at least 44 CSS pixels tall.
  const small = await review.locator('button, input, select, summary, textarea').evaluateAll((controls) => controls
    .map((control) => ({ control, target: control.type === 'checkbox' ? control.closest('label') ?? control : control }))
    .map(({ control, target }) => ({ name: control.getAttribute('aria-label') ?? control.textContent?.trim() ?? control.tagName, ...target.getBoundingClientRect().toJSON() }))
    .filter((control) => control.width > 0 && (control.height < 44 || control.width < 44))
    .map(({ name, width, height }) => ({ name, width, height })));
  assert.deepEqual(small, [], 'controls smaller than 44 by 44 pixels');

  // Keyboard on the phone: untick a prerequisite (its dependents follow), restore it, approve.
  await focusByLabel(page, review.getByLabel('Keep Build the subscription API'));
  await page.keyboard.press('Space');
  await page.getByRole('status').getByText(/Dependent item removed/).waitFor();
  await focusByLabel(page, review.getByLabel('Add Run QA and UAT'));
  await page.keyboard.press('Space');
  await page.getByRole('status').getByText(/Prerequisite restored/).waitFor();
  await review.getByText('4 of 4 kept', { exact: false }).waitFor();
  const approve = review.getByRole('button', { name: 'Approve' });
  await focusByLabel(page, approve);
  const box = await approve.boundingBox();
  assert.ok(box.height >= 44 && box.y + box.height <= 844 + 1000, 'Approve is large enough');
  await page.keyboard.press('Enter');
  await review.getByRole('status').getByText(/Proposal approved/).waitFor();
  await context.close();
});
