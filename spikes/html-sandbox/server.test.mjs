import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createSandboxServer } from './server.mjs';

let server;
let origin;

before(async () => {
  server = createSandboxServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('sandbox fixture route is locked both inside and outside the application frame', async () => {
  const response = await fetch(`${origin}/vault-pages/spike.html`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(response.headers.get('content-security-policy'), `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline' 'self'; img-src ${origin} data:; connect-src 'none'; form-action 'none'`);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const html = await response.text();
  assert.match(html, /data-sandbox-probe/);
  assert.match(html, /<form\b/i, 'the probe includes a form so the policy is exercised');
});

test('application harness embeds the fixture with only the script sandbox permission', async () => {
  const response = await fetch(`${origin}/sandbox-spike`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<iframe[^>]+src="\/vault-pages\/spike\.html"[^>]+sandbox="allow-scripts"/i);
  assert.doesNotMatch(html, /sandbox="[^"]*(?:allow-same-origin|allow-popups|allow-top-navigation|allow-forms)/i);
});
