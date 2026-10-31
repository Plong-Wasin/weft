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

// Plan milestones with AI, driven end to end in a real browser with a scripted provider: the runner
// below speaks the same outbound protocol as the real bridge, reads the Project through the read
// tools and drafts a plan.

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const binary = resolve(appRoot, 'target/debug/weft');
const databaseUrl = process.env.WEFT_E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://weft:weft@127.0.0.1:55432/postgres';
const schema = `weft_plan_${randomUUID().replaceAll('-', '')}`;
const vaultRoot = `/tmp/weft-e2e-vaults-${schema}`;
const password = 'plan journey password';
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
  run(binary, ['bootstrap-admin', 'owner@example.com', password, 'Plan Workspace'], env);
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
          const existing = (await tool({ tool: 'list_milestones' })).results[0].data.milestones;
          const found = (await tool({ tool: 'search_tasks', query: 'release' })).results.map((result) => result.data);
          const write = found.find((item) => item.title === 'Write release notes');
          const publish = found.find((item) => item.title === 'Publish release');
          const project = payload.scope.projects[0];
          const items = [
            { id: 'tmp-beta', kind: 'milestone', project_id: project, name: 'Closed beta', description: 'First external users', target_date: '2026-12-15', reason: 'The goal names a beta before launch.', sources: [] },
            { id: 'tmp-testers', kind: 'task', project_id: project, title: 'Recruit beta testers', reason: 'A beta needs testers and none are planned.', sources: [] },
            { id: 'tmp-assign-write', kind: 'milestone_assign', task_id: write.id, milestone_id: 'tmp-beta', expected_version: write.version, reason: 'Notes ship with the beta.', sources: [] },
            { id: 'tmp-assign-publish', kind: 'milestone_assign', task_id: publish.id, milestone_id: existing[0].id, expected_version: publish.version, reason: 'Publishing is the launch itself.', sources: [] },
            { id: 'tmp-assign-testers', kind: 'milestone_assign', task_id: 'tmp-testers', milestone_id: 'tmp-beta', reason: 'Testers are part of the beta.', sources: [] },
            { id: 'tmp-order', kind: 'relation', relation: 'blocks', source_task_id: write.id, target_task_id: publish.id, reason: 'Notes come before publishing.', sources: [] },
          ];
          await post(`jobs/${leased.job.id}/result`, { result: { summary: 'Planned one Milestone and its order from the goal', outcome: 'waiting_for_approval', proposal: { schema_version: 1, items, assumptions: ['Beta users are internal staff'], open_questions: ['Which date does legal need?'] }, tool_activity: [{ tool: 'search_tasks', truncated: true }] } });
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

test('a keyboard-only manager plans milestones with AI, edits the plan, approves it once and undoes it', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await signIn(page);
  const me = await page.request.get(`${origin}/api/v1/auth/me`).then((response) => response.json());
  const workspaceId = me.workspaces[0].id;
  psql(`SET search_path TO ${schema}; INSERT INTO ai_connections(id,scope,workspace_id,provider,auth_mode,billing_mode,state,state_reason,created_by) SELECT '${connectionId}','workspace',w.id,'scripted','provider_cli','api','ready','ready',m.user_id FROM workspaces w JOIN workspace_memberships m ON m.workspace_id=w.id WHERE m.role='owner' LIMIT 1; INSERT INTO ai_connection_grants(connection_id,workspace_id) SELECT id,workspace_id FROM ai_connections WHERE id='${connectionId}'; INSERT INTO ai_default_policies(scope,workspace_id,connection_id) SELECT 'workspace',workspace_id,id FROM ai_connections WHERE id='${connectionId}';`);
  const project = await api(page, 'POST', `/workspaces/${workspaceId}/projects`, { name: 'Release', visibility: 'workspace' });
  const write = await api(page, 'POST', `/workspaces/${workspaceId}/tasks`, { project_id: project.id, title: 'Write release notes' });
  const publish = await api(page, 'POST', `/workspaces/${workspaceId}/tasks`, { project_id: project.id, title: 'Publish release' });
  const launch = await api(page, 'POST', `/projects/${project.id}/milestones`, { name: 'Public launch', target_date: '2027-01-15' });
  await startScriptedRunner(page);
  await page.reload();
  await page.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
  await page.getByRole('button', { name: 'My work', exact: true }).click();
  await page.getByText(/AI planning is ready/).waitFor();
  await page.getByLabel('Project', { exact: true }).selectOption({ label: 'Release' });
  await page.getByRole('button', { name: 'Plan milestones with AI' }).waitFor();

  // Start from the command palette with the keyboard alone.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+k');
  await page.waitForFunction(() => document.activeElement?.id === 'command-search');
  await page.keyboard.type('plan milestones Get the beta ready before launch');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Plan milestones' });
  await dialog.waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'ai-goal');
  assert.match(await dialog.getByLabel('Goal').inputValue(), /beta ready/);
  await dialog.getByRole('region', { name: 'Sources and provider' }).getByText('project: Release').waitFor();
  await tabTo(page, 'Plan milestones');
  await page.keyboard.press('Enter');

  const review = page.getByRole('region', { name: 'Proposal review' });
  await review.getByRole('heading', { name: 'Proposal checklist' }).waitFor();
  await review.getByLabel('Keep Closed beta').waitFor();
  const tree = review.getByRole('region', { name: 'Plan tree' });
  await tree.getByText('Closed beta').waitFor();
  await tree.getByText('The goal names a beta before launch.').waitFor();
  await tree.getByText('Recruit beta testers').waitFor();
  await tree.getByText(/Write release notes blocks #\d+ Publish release/).waitFor();
  await review.getByText('Beta users are internal staff').waitFor();
  await review.getByText('Which date does legal need?').waitFor();
  await review.getByRole('region', { name: 'AI run notes' }).getByText(/cut short/).waitFor();
  await review.getByText(/Creates 1, creates 1 Milestones, assigns 3 Tasks, updates 2, links 1/).waitFor();
  // Nothing is written before approval.
  assert.equal((await api(page, 'GET', `/projects/${project.id}/milestones`)).milestones.length, 1);

  // Rename the Milestone by hand with the keyboard; blur saves.
  const milestoneRow = review.locator('.proposal-group[aria-label="Milestones proposal items"] li').filter({ hasText: 'Closed beta' });
  await milestoneRow.getByRole('button', { name: 'Show details' }).focus();
  await page.keyboard.press('Enter');
  await review.getByLabel('Name for Closed beta').fill('Closed beta 1');
  await page.keyboard.press('Tab');
  await page.getByRole('status').getByText('Edit saved.').waitFor();
  await tree.getByText('Closed beta 1').waitFor();

  // Unticking the Milestone unticks the assignments that need it, and ticking one brings it back.
  await review.getByLabel('Keep Closed beta 1').focus();
  await page.keyboard.press('Space');
  await review.getByText('0 of 1 kept', { exact: false }).first().waitFor();
  await review.getByLabel(/Add #\d+ Write release notes in Closed beta 1/).focus();
  await page.keyboard.press('Space');
  await review.getByLabel('Keep Closed beta 1').waitFor();

  await review.getByRole('button', { name: 'Approve' }).focus();
  await page.keyboard.press('Enter');
  await review.getByRole('status').getByText(/Proposal approved/).waitFor();
  const milestones = (await api(page, 'GET', `/projects/${project.id}/milestones`)).milestones;
  const beta = milestones.find((item) => item.name === 'Closed beta 1');
  assert.ok(beta, 'the Milestone was created');
  assert.equal((await api(page, 'GET', `/workspaces/${workspaceId}/tasks/${write.number}`)).milestone_id, beta.id);
  assert.equal((await api(page, 'GET', `/workspaces/${workspaceId}/tasks/${publish.number}`)).milestone_id, launch.id);

  await review.getByRole('button', { name: 'Undo' }).focus();
  await page.keyboard.press('Enter');
  await review.getByRole('status').getByText(/Proposal changes undone/).waitFor();
  assert.equal((await api(page, 'GET', `/workspaces/${workspaceId}/tasks/${write.number}`)).milestone_id, null);
  assert.equal((await api(page, 'GET', `/projects/${project.id}/milestones`)).milestones.filter((item) => !item.archived).length, 1);
  await context.close();
});
