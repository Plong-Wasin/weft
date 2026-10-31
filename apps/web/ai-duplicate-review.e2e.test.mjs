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

// Duplicate hints and Task quality review, driven end to end in a real browser with a scripted provider:
// the runner below speaks the same outbound protocol as the real bridge but invents a fixed plan.

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const binary = resolve(appRoot, 'target/debug/weft');
const databaseUrl = process.env.WEFT_E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://weft:weft@127.0.0.1:55432/postgres';
const schema = `weft_aidup_${randomUUID().replaceAll('-', '')}`;
const vaultRoot = `/tmp/weft-e2e-vaults-${schema}`;
const password = 'ai duplicate journey password';
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
          globalThis.markLeased?.();
          if (payload.capability === 'review') {
            const taskId = payload.scope.tasks[0];
            const tool = await post(`jobs/${leased.job.id}/tools`, { call: { tool: 'read_task_chat', task_id: taskId } }).then((response) => response.json());
            const version = Number(psqlValue(`SELECT version FROM tasks WHERE id='${taskId}'`));
            const project = payload.scope.projects[0];
            await post(`jobs/${leased.job.id}/result`, { result: { summary: 'The Task needs a measurable done condition.', outcome: 'waiting_for_approval', tool_activity: [{ tool: 'read_task_chat', truncated: tool.truncated }], findings: [{ category: 'vague_criteria', reason: 'Nothing says when the report counts as published.', sources: [{ kind: 'task_chat', id: taskId }, { kind: 'task', id: randomUUID() }] }], proposal: { schema_version: 1, items: [{ id: 'tmp-criteria', kind: 'task', project_id: project, title: 'Write acceptance criteria', description: '', reason: 'The review found no measurable done condition.', sources: [], source_task_id: taskId, expected_version: version }], assumptions: [], open_questions: [] } } });
            continue;
          }
          const numbers = [...payload.arguments[0].matchAll(/task #(\d+)/g)].map((match) => Number(match[1]));
          const ids = numbers.map((number) => psqlValue(`SELECT id FROM tasks WHERE number=${number}`));
          await post(`jobs/${leased.job.id}/result`, { result: { summary: 'Proposed a Duplicate relation', outcome: 'waiting_for_approval', proposal: { schema_version: 1, items: [{ id: 'tmp-duplicate', kind: 'relation', relation: 'duplicate', source_task_id: ids[1], target_task_id: ids[0], reason: 'The titles describe the same work.', sources: [] }], assumptions: [], open_questions: [] } } });
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

test('a keyboard-only member goes from a duplicate hint to a Proposal and approves it without anything closing', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await signIn(page);
  const me = await page.request.get(`${origin}/api/v1/auth/me`).then((response) => response.json());
  workspaceId = me.workspaces[0].id;
  projectId = (await api(page, 'POST', `/workspaces/${workspaceId}/projects`, { name: 'Reports', visibility: 'workspace' })).id;
  await api(page, 'POST', `/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'Quarterly sales report' });
  await api(page, 'POST', `/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'Quarterly sales report v2' });
  psql(`SET search_path TO ${schema}; INSERT INTO ai_connections(id,scope,workspace_id,provider,auth_mode,billing_mode,state,state_reason,created_by) SELECT '${connectionId}','workspace',w.id,'scripted','provider_cli','api','ready','ready',m.user_id FROM workspaces w JOIN workspace_memberships m ON m.workspace_id=w.id WHERE m.role='owner' LIMIT 1; INSERT INTO ai_connection_grants(connection_id,workspace_id) SELECT id,workspace_id FROM ai_connections WHERE id='${connectionId}'; INSERT INTO ai_default_policies(scope,workspace_id,connection_id) SELECT 'workspace',workspace_id,id FROM ai_connections WHERE id='${connectionId}';`);
  await startScriptedRunner(page);
  await page.reload();
  await page.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
  await page.getByRole('button', { name: 'My work', exact: true }).click();
  await page.getByText(/AI planning is ready/).waitFor();
  await openTaskByTitle(page, 'Quarterly sales report v2');
  const panel = page.getByRole('region', { name: /^Task #/ });
  const hints = panel.getByRole('region', { name: 'Likely duplicates' });
  await hints.getByText(/Quarterly sales report/).first().waitFor();
  await hints.getByText('Only Tasks you can open are compared.').waitFor();
  await tabTo(page, 'Propose Duplicate relation');
  await page.keyboard.press('Enter');
  await page.getByRole('dialog', { name: 'Suggest links' }).waitFor();
  await tabTo(page, 'Suggest links');
  await page.keyboard.press('Enter');
  const review = page.getByRole('region', { name: 'Proposal review' });
  await review.getByLabel(/Keep duplicate link: #\d+ .* to #\d+ /).waitFor();
  await review.getByRole('button', { name: 'Approve' }).focus();
  await page.keyboard.press('Enter');
  await review.getByRole('status').getByText(/Proposal approved/).waitFor();
  assert.equal(psqlValue("SELECT count(*) FROM task_relations WHERE kind='duplicate'"), '1');
  assert.equal(psqlValue("SELECT count(*) FROM tasks WHERE archived_at IS NOT NULL OR status<>'todo'"), '0', 'a duplicate hint never merges or closes a Task');
  await context.close();
});

test('a keyboard-only member reviews Task quality, sees findings with Sources, and opens the Proposal', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await signIn(page);
  await page.getByText(/AI planning is ready/).waitFor();
  await openTaskByTitle(page, 'Quarterly sales report v2');
  const taskId = psqlValue("SELECT id FROM tasks WHERE title='Quarterly sales report v2'");
  await tabTo(page, 'Review task quality');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Review task quality' });
  await dialog.waitFor();
  await tabTo(page, 'Start review');
  await page.keyboard.press('Enter');
  const report = dialog.getByRole('region', { name: 'Task quality review' });
  await report.getByText('Vague criteria').waitFor();
  await report.getByText(/Nothing says when the report counts as published/).waitFor();
  await report.getByText(/Sources: Task chat: #\d+ Quarterly sales report v2$/).waitFor();
  assert.equal(psqlValue("SELECT count(*) FROM tasks WHERE title='Write acceptance criteria'"), '0');
  await report.getByRole('button', { name: 'Open Proposal' }).focus();
  await page.keyboard.press('Enter');
  const review = page.getByRole('region', { name: 'Proposal review' });
  await review.getByLabel('Keep Write acceptance criteria').waitFor();
  await review.getByRole('button', { name: 'Approve' }).focus();
  await page.keyboard.press('Enter');
  await review.getByRole('status').getByText(/Proposal approved/).waitFor();
  assert.equal(psqlValue(`SELECT parent_task_id='${taskId}' FROM tasks WHERE title='Write acceptance criteria'`), 't');
  await context.close();
});
