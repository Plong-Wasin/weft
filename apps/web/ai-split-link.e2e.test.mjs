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

// Suggest split and Suggest links, driven end to end in a real browser with a scripted provider:
// the runner below speaks the same outbound protocol as the real bridge but invents a fixed plan.

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const binary = resolve(appRoot, 'target/debug/weft');
const databaseUrl = process.env.WEFT_E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://weft:weft@127.0.0.1:55432/postgres';
const schema = `weft_ailink_${randomUUID().replaceAll('-', '')}`;
const vaultRoot = `/tmp/weft-e2e-vaults-${schema}`;
const password = 'ai link journey password';
const connectionId = randomUUID();
let server;
let browser;
let origin;
let runnerStop = false;
let runnerLoop;
let holdResult = null;

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

function psqlValue(sql) {
  const args = ['-d', databaseUrl, '-v', 'ON_ERROR_STOP=1', '-tA', '-c', `SET search_path TO ${schema}; ${sql}`];
  let result = spawnSync('psql', args, { encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') result = spawnSync('docker', ['exec', 'weft-shared-pg', 'psql', '-U', 'weft', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-tA', '-c', `SET search_path TO ${schema}; ${sql}`], { encoding: 'utf8' });
  assert.equal(result.status, 0, `psql failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout.split('\n').filter((line) => line && !line.startsWith('SET')).join('\n').trim();
}

const sleep = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));


function planFor(prompt, project, focus) {
  const task = (id, title, extra = {}) => ({ id, kind: 'task', project_id: project, title, description: '', reason: `Separate piece of work: ${title}.`, sources: [], source_task_id: focus.id, expected_version: focus.version, ...extra });
  if (/split task/.test(prompt)) {
    return {
      items: [task('tmp-numbers', 'Collect the numbers'), task('tmp-layout', 'Design the layout', { split_mode: 'peer' })],
      remaining_in_original: ['Publishing and sign-off stay in the original Task'],
      assumptions: [], open_questions: [],
    };
  }
  const others = JSON.parse(psqlValue(`SELECT COALESCE(json_agg(json_build_object('id',id,'title',title) ORDER BY number),'[]') FROM tasks WHERE project_id='${project}' AND id<>'${focus.id}'`));
  const copy = others.find((item) => item.title === 'Report copy');
  const slides = others.find((item) => item.title === 'Report slides');
  const relation = (id, kind, source, target, reason) => ({ id, kind: 'relation', relation: kind, source_task_id: source, target_task_id: target, reason, sources: [] });
  return {
    items: [
      relation('tmp-duplicate', 'duplicate', copy.id, focus.id, 'The copy repeats this Task.'),
      relation('tmp-parent', 'parent', focus.id, slides.id, 'The slides are part of the report.'),
    ],
    assumptions: [], open_questions: [],
  };
}

async function startScriptedRunner(page) {
  const csrf = (await page.context().cookies(origin)).find((cookie) => cookie.name === 'weft_csrf')?.value;
  const code = await page.request.post(`${origin}/api/v1/ai/connections/${connectionId}/runners/pairing-codes`, { data: {}, headers: { 'x-csrf-token': csrf } }).then((response) => response.json());
  const paired = await fetch(`${origin}/api/v1/ai/agent/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code.code, name: 'scripted', version: 'e2e', supported_modes: ['scripted'] }) }).then((response) => response.json());
  const headers = { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' };
  const post = (path, body) => fetch(`${origin}/api/v1/ai/agent/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  // The page reads the Connection state once on load, so the Connection must already be ready
  // when this returns; the first heartbeat is what makes it ready after pairing.
  await post('heartbeat', {});
  runnerLoop = (async () => {
    while (!runnerStop) {
      try {
        await post('heartbeat', {});
        const leased = await post('jobs/lease', {}).then((response) => response.json());
        if (leased.job) {
          const { payload } = leased.job;
          const focusId = payload.scope.tasks[0];
          // The version the "model" saw when it read the Task.
          const focus = { id: focusId, version: Number(psqlValue(`SELECT version FROM tasks WHERE id='${focusId}'`)) };
          globalThis.markLeased?.();
          const plan = planFor(payload.arguments[0], payload.scope.projects[0], focus);
          if (holdResult) await holdResult;
          await post(`jobs/${leased.job.id}/result`, { result: { summary: 'Drafted suggestions', outcome: 'waiting_for_approval', proposal: { schema_version: 1, ...plan } } });
          continue;
        }
      } catch (reason) { if (!runnerStop) console.error('runner', reason); }
      await sleep(200);
    }
  })();
}
before(async () => {
  await access(binary);
  await access(resolve(appRoot, 'apps/web/dist/index.html'));
  psql(`CREATE SCHEMA ${schema}`);
  const scopedDatabaseUrl = `${databaseUrl}?options=-csearch_path%3D${schema}`;
  const env = { ...process.env, DATABASE_URL: scopedDatabaseUrl, WEFT_WEB_ROOT: resolve(appRoot, 'apps/web/dist'), WEFT_VAULT_ROOT: vaultRoot, WEFT_AGENT_SIGNING_KEY: 'e2e-link-runner-signing-key-01234567890123456789012' };
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
  await page.getByRole('button', { name: 'My work', exact: true }).click();
}

async function tabTo(page, name) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if (await page.evaluate((label) => (document.activeElement?.textContent ?? '').trim() === label || document.activeElement?.getAttribute('aria-label') === label, name)) return;
    await page.keyboard.press('Tab');
  }
  assert.fail(`Tab never reached ${name}`);
}


async function csrfOf(page) {
  return (await page.context().cookies(origin)).find((cookie) => cookie.name === 'weft_csrf')?.value;
}

async function api(page, method, path, data) {
  const response = await page.request.fetch(`${origin}/api/v1${path}`, { method, data, headers: { 'x-csrf-token': await csrfOf(page) } });
  assert.ok(response.ok(), `${method} ${path} -> ${response.status()} ${await response.text()}`);
  return response.json();
}

let workspaceId;
let projectId;

async function openTaskByTitle(page, title) {
  await page.keyboard.press('Escape');
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+k');
  await page.waitForFunction(() => document.activeElement?.id === 'command-search');
  await page.keyboard.type(title);
  await page.getByRole('dialog', { name: 'Command palette' }).getByRole('option', { name: new RegExp(title) }).click();
  await page.getByRole('region', { name: /^Task #/ }).waitFor();
}

test('without a ready connection Suggest split and Suggest links show why they are unavailable', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await signIn(page);
  const me = await page.request.get(`${origin}/api/v1/auth/me`).then((response) => response.json());
  workspaceId = me.workspaces[0].id;
  projectId = (await api(page, 'POST', `/workspaces/${workspaceId}/projects`, { name: 'Reports', visibility: 'workspace' })).id;
  await page.reload();
  await page.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
  await page.getByRole('button', { name: 'My work', exact: true }).click();
  await page.getByLabel('Project', { exact: true }).selectOption({ label: 'Reports' });
  await page.getByLabel('Task title').fill('Publish the report');
  await page.getByRole('button', { name: 'Create task' }).click();
  const panel = page.getByRole('region', { name: /^Task #/ });
  await panel.waitFor();
  assert.equal(await panel.getByRole('button', { name: 'Suggest split' }).isDisabled(), true);
  assert.equal(await panel.getByRole('button', { name: 'Suggest links' }).isDisabled(), true);
  await panel.getByText(/AI suggestions are unavailable: No AI connection/).waitFor();
  await panel.getByLabel('Title', { exact: true }).fill('Publish the report (edited)');
  await context.close();
});

test('keyboard-only Suggest split from the Task panel survives a Task change through refresh, then approves and undoes', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await signIn(page);
  await api(page, 'POST', `/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'Report copy' });
  await api(page, 'POST', `/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'Report slides' });
  psql(`SET search_path TO ${schema}; INSERT INTO ai_connections(id,scope,workspace_id,provider,auth_mode,billing_mode,state,state_reason,created_by) SELECT '${connectionId}','workspace',w.id,'scripted','provider_cli','api','ready','ready',m.user_id FROM workspaces w JOIN workspace_memberships m ON m.workspace_id=w.id WHERE m.role='owner' LIMIT 1; INSERT INTO ai_connection_grants(connection_id,workspace_id) SELECT id,workspace_id FROM ai_connections WHERE id='${connectionId}'; INSERT INTO ai_default_policies(scope,workspace_id,connection_id) SELECT 'workspace',workspace_id,id FROM ai_connections WHERE id='${connectionId}';`);
  await startScriptedRunner(page);
  await page.reload();
  await page.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
  await page.getByRole('button', { name: 'My work', exact: true }).click();
  await page.getByText(/AI planning is ready/).waitFor();
  await openTaskByTitle(page, 'Publish the report');
  const panel = page.getByRole('region', { name: /^Task #/ });
  const sourceId = psqlValue("SELECT id FROM tasks WHERE title LIKE 'Publish the report%'");

  // Reach Suggest split with Tab and start it with Enter; hold the provider while the Task changes.
  holdResult = new Promise((release) => { globalThis.releaseRun = release; });
  const leased = new Promise((resolveLeased) => { globalThis.markLeased = resolveLeased; });
  await tabTo(page, 'Suggest split');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Suggest split' });
  await dialog.waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'ai-goal');
  await dialog.getByText(/Task: #\d+ Publish the report/).waitFor();
  await dialog.getByRole('region', { name: 'Sources and provider' }).getByText(/task: #\d+ Publish the report/).waitFor();
  await tabTo(page, 'Suggest split');
  await page.keyboard.press('Enter');
  await dialog.getByRole('status').waitFor();
  // Someone edits the source Task after the run started and the "model" read it.
  await leased;
  psqlValue(`UPDATE tasks SET description='Changed while the run worked',version=version+1,updated_at=now() WHERE id='${sourceId}' RETURNING 1`);
  globalThis.releaseRun();
  holdResult = null;

  const review = page.getByRole('region', { name: 'Proposal review' });
  await review.getByLabel('Keep Collect the numbers').waitFor();
  await review.getByRole('region', { name: 'Stays in the original Task' }).getByText('Publishing and sign-off stay in the original Task').waitFor();
  await review.getByText('Separate piece of work: Collect the numbers.').waitFor();
  await review.getByText(/related link: #\d+ Publish the report to Collect the numbers/).first().waitFor();
  // The stale items block Approve until they are refreshed or removed.
  await review.getByRole('alert').getByText('Some items are stale.').waitFor();
  assert.equal(await review.getByRole('button', { name: 'Approve' }).isDisabled(), true);
  assert.equal(psqlValue("SELECT count(*) FROM tasks WHERE title IN ('Collect the numbers','Design the layout')"), '0');
  await review.getByRole('button', { name: 'Refresh stale items' }).focus();
  await page.keyboard.press('Enter');
  await review.getByText(/Stale items now use the current Task versions/).waitFor();
  await review.getByText('Some items are stale.').waitFor({ state: 'detached' });
  await review.getByRole('button', { name: 'Approve' }).focus();
  await page.keyboard.press('Enter');
  await review.getByRole('status').getByText(/Proposal approved/).waitFor();
  assert.equal(psqlValue(`SELECT parent_task_id='${sourceId}' FROM tasks WHERE title='Collect the numbers'`), 't');
  assert.equal(psqlValue("SELECT parent_task_id IS NULL FROM tasks WHERE title='Design the layout'"), 't');
  assert.equal(psqlValue(`SELECT description FROM tasks WHERE id='${sourceId}'`), 'Changed while the run worked');
  await review.getByRole('button', { name: 'Undo' }).focus();
  await page.keyboard.press('Enter');
  await review.getByRole('status').getByText(/Proposal changes undone/).waitFor();
  assert.equal(psqlValue("SELECT count(*) FROM tasks WHERE title IN ('Collect the numbers','Design the layout') AND archived_at IS NULL"), '0');
  await context.close();
});

test('Suggest links from the command palette shows each link type, approves, and a duplicate closes nothing', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await signIn(page);
  await page.getByText(/AI planning is ready/).waitFor();
  await openTaskByTitle(page, 'Publish the report');
  const sourceId = psqlValue("SELECT id FROM tasks WHERE title LIKE 'Publish the report%'");
  await page.keyboard.press('Control+k');
  await page.waitForFunction(() => document.activeElement?.id === 'command-search');
  await page.keyboard.type('links');
  await page.getByRole('dialog', { name: 'Command palette' }).getByRole('option', { name: /Suggest links/ }).waitFor();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Suggest links' });
  await dialog.waitFor();
  await tabTo(page, 'Suggest links');
  await page.keyboard.press('Enter');
  const review = page.getByRole('region', { name: 'Proposal review' });
  await review.getByLabel(/Keep duplicate link: #\d+ Report copy to #\d+ Publish the report/).waitFor();
  await review.getByLabel(/Keep parent link: #\d+ Publish the report is the parent of #\d+ Report slides/).waitFor();
  await review.getByText('Creates 0, updates 3, links 2.').waitFor();
  await review.getByRole('button', { name: 'Approve' }).focus();
  await page.keyboard.press('Enter');
  await review.getByRole('status').getByText(/Proposal approved/).waitFor();
  assert.equal(psqlValue(`SELECT count(*) FROM task_relations WHERE kind='duplicate'`), '1');
  assert.equal(psqlValue(`SELECT parent_task_id='${sourceId}' FROM tasks WHERE title='Report slides'`), 't');
  assert.equal(psqlValue("SELECT count(*) FROM tasks WHERE title IN ('Publish the report','Report copy','Report slides') AND (archived_at IS NOT NULL OR status<>'todo')"), '0', 'a duplicate suggestion never closes or archives a Task');
  await context.close();
});
