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
import { goTo, openNewTask } from './e2e-helpers.mjs';

// AI progress review, driven end to end in a real browser with a scripted provider: the runner below
// speaks the same outbound protocol as the real bridge, reads the risks through the read tools and
// reports findings plus one fix Proposal.

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const binary = resolve(appRoot, 'target/debug/weft');
const databaseUrl = process.env.WEFT_E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://weft:weft@127.0.0.1:55432/postgres';
const schema = `weft_progress_${randomUUID().replaceAll('-', '')}`;
const vaultRoot = `/tmp/weft-e2e-vaults-${schema}`;
const password = 'progress journey password';
const connectionId = randomUUID();
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

before(async () => {
  await access(binary);
  await access(resolve(appRoot, 'apps/web/dist/index.html'));
  psql(`CREATE SCHEMA ${schema}`);
  const scopedDatabaseUrl = `${databaseUrl}?options=-csearch_path%3D${schema}`;
  const env = { ...process.env, DATABASE_URL: scopedDatabaseUrl, WEFT_WEB_ROOT: resolve(appRoot, 'apps/web/dist'), WEFT_VAULT_ROOT: vaultRoot, WEFT_AGENT_SIGNING_KEY: 'e2e-runner-signing-key-0123456789012345678901234567' };
  run(binary, ['bootstrap-admin', 'owner@example.com', password, 'Progress Workspace'], env);
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

async function workspaceTasks(page, workspaceId) {
  return (await page.request.get(`${origin}/api/v1/workspaces/${workspaceId}/tasks`).then((response) => response.json())).tasks.map((item) => item.title);
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
          const tool = (call) => post(`jobs/${leased.job.id}/tools`, { call }).then((response) => response.json());
          const risks = (await tool({ tool: 'list_progress_risks' })).results;
          const late = risks.find((result) => result.source.kind === 'task' && result.data.risks.includes('overdue'));
          const empty = risks.find((result) => result.source.kind === 'milestone' && result.data.risks.includes('empty_milestone'));
          const project = payload.scope.projects[0];
          const items = [
            { id: 'tmp-move', kind: 'milestone_update', milestone_id: empty.data.id, expected_version: empty.data.version ?? 1, target_date: '2027-03-01', reason: 'No work is planned for this date.', sources: [] },
            { id: 'tmp-sub', kind: 'task', project_id: project, title: 'Triage the overdue payment fix', source_task_id: late.data.id, expected_version: (await tool({ tool: 'get_task', task_id: late.data.id })).results[0].data.version, reason: 'The overdue Task needs a first small step.', sources: [] },
          ];
          await post(`jobs/${leased.job.id}/result`, { result: { summary: 'One Task is overdue and one Milestone is empty', outcome: 'waiting_for_approval', findings: [
            { category: 'overdue', reason: 'Due in 2020 and still open.', sources: [{ kind: 'task', id: late.source.id }] },
            { category: 'empty_milestone', reason: 'No Task belongs to it.', sources: [{ kind: 'milestone', id: empty.source.id }] },
          ], proposal: { schema_version: 1, items, assumptions: ['Dates are not shifted automatically'], open_questions: [] } } });
          continue;
        }
      } catch { /* the server is shutting down */ }
      await sleep(200);
    }
  })();
}

async function api(page, method, path, data) {
  const csrf = (await page.context().cookies(origin)).find((cookie) => cookie.name === 'weft_csrf')?.value;
  const response = await page.request.fetch(`${origin}/api/v1${path}`, { method, data, headers: { 'x-csrf-token': csrf } });
  assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
  return response.json();
}

test('a keyboard-only manager reviews progress from the Project overview and opens the resulting Proposal', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await signIn(page);
  const me = await page.request.get(`${origin}/api/v1/auth/me`).then((response) => response.json());
  const workspaceId = me.workspaces[0].id;
  psql(`SET search_path TO ${schema}; INSERT INTO ai_connections(id,scope,workspace_id,provider,auth_mode,billing_mode,state,state_reason,created_by) SELECT '${connectionId}','workspace',w.id,'scripted','provider_cli','api','ready','ready',m.user_id FROM workspaces w JOIN workspace_memberships m ON m.workspace_id=w.id WHERE m.role='owner' LIMIT 1; INSERT INTO ai_connection_grants(connection_id,workspace_id) SELECT id,workspace_id FROM ai_connections WHERE id='${connectionId}'; INSERT INTO ai_default_policies(scope,workspace_id,connection_id) SELECT 'workspace',workspace_id,id FROM ai_connections WHERE id='${connectionId}';`);
  const project = await api(page, 'POST', `/workspaces/${workspaceId}/projects`, { name: 'Release', visibility: 'workspace' });
  await api(page, 'POST', `/workspaces/${workspaceId}/tasks`, { project_id: project.id, title: 'Fix the payment bug' });
  await api(page, 'POST', `/projects/${project.id}/milestones`, { name: 'Public launch', target_date: '2027-01-15' });
  psql(`SET search_path TO ${schema}; UPDATE tasks SET due_date='2020-01-01' WHERE title='Fix the payment bug';`);
  await startScriptedRunner(page);
  await page.reload();
  await page.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
  await page.getByRole('button', { name: 'My work', exact: true }).click();
  const readyDialog = await openNewTask(page);
  await readyDialog.getByText(/AI planning is ready/).waitFor();
  await page.keyboard.press('Escape');
  await readyDialog.waitFor({ state: 'hidden' });
  await goTo(page, 'Milestones');
  await page.getByRole('button', { name: 'Review progress with AI' }).waitFor();

  // Reach the overview button and start the review with the keyboard alone.
  await page.getByRole('button', { name: 'Plan milestones with AI' }).focus();
  await tabTo(page, 'Review progress with AI');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Review progress' });
  await dialog.waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'ai-goal');
  await dialog.getByRole('region', { name: 'Sources and provider' }).getByText('project: Release').waitFor();
  await tabTo(page, 'Start review');
  await page.keyboard.press('Enter');

  const report = dialog.getByRole('region', { name: 'Progress review' });
  await report.getByText('One Task is overdue and one Milestone is empty').waitFor();
  await report.getByText(/Overdue/).waitFor();
  await report.getByText(/Due in 2020 and still open/).waitFor();
  await report.getByText(/Sources: #\d+ Fix the payment bug/).waitFor();
  await report.getByText(/Empty Milestone/).waitFor();
  await report.getByText(/not available to AI/).waitFor();
  // Nothing is written before a person approves.
  assert.equal((await workspaceTasks(page, workspaceId)).length, 1);

  await page.waitForFunction(() => document.activeElement?.textContent === 'Open Proposal');
  await page.keyboard.press('Enter');
  const review = page.getByRole('region', { name: 'Proposal review' });
  await review.getByRole('heading', { name: 'Proposal checklist' }).waitFor();
  await review.getByText('Triage the overdue payment fix').first().waitFor();
  await review.getByText('No work is planned for this date.').first().waitFor();
  assert.equal((await workspaceTasks(page, workspaceId)).length, 1);
  await context.close();
});
