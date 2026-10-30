import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { chromium } from 'playwright';

const policy = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline' 'self'; img-src 'self' data:; connect-src 'none'; form-action 'none'";

test('Vault HTML runs inline scripts while sandbox blocks access and outbound actions', async () => {
  const reached = [];
  const server = createServer((request, response) => {
    reached.push(request.url);
    if (request.url === '/parent') {
      response.setHeader('set-cookie', 'parent_secret=private; HttpOnly; SameSite=Lax');
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><title>parent</title><div id="results"></div><iframe title="Vault page" sandbox="allow-scripts" src="/vault-pages/one/hostile.html"></iframe><script>addEventListener("message", event => { document.querySelector("#results").textContent = JSON.stringify(event.data); })</script>');
    } else if (request.url === '/vault-pages/one/hostile.html') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.setHeader('content-security-policy', policy);
      response.setHeader('x-content-type-options', 'nosniff');
      response.end(`<!doctype html><title>Vault</title><body><script>
        (async () => {
          const result = { ran: true, cookie: '', parentReadable: false, fetchBlocked: false, imageBlocked: false, formBlocked: false, popupBlocked: false, frameBlocked: false, blockedDirectives: [] };
          addEventListener('securitypolicyviolation', event => result.blockedDirectives.push(event.effectiveDirective));
          try { result.cookie = document.cookie; } catch { result.cookie = 'blocked'; }
          try { result.parentReadable = window.parent.document.cookie.includes('parent_secret'); } catch { result.parentReadable = false; }
          try { await fetch('/api/v1/vaults/two/contents'); } catch { result.fetchBlocked = true; }
          const image = new Image(); image.src = 'https://outside.invalid/beacon';
          result.imageBlocked = true;
          const form = document.createElement('form'); form.method = 'post'; form.action = '/collect'; document.body.append(form); form.submit(); result.formBlocked = true;
          result.popupBlocked = window.open('https://outside.invalid/') === null;
          const frame = document.createElement('iframe'); frame.src = '/vault-pages/two/private.html'; document.body.append(frame); result.frameBlocked = true;
          await new Promise(resolve => setTimeout(resolve, 50));
          parent.postMessage(result, '*');
        })();
      </script>`);
    } else {
      response.statusCode = 404;
      response.end('not found');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const browser = await chromium.launch({ headless: true, ...(process.env.WEFT_CHROMIUM_PATH ? { executablePath: process.env.WEFT_CHROMIUM_PATH } : {}) });
  try {
    const page = await browser.newPage();
    const browserErrors = [];
    page.on('console', (message) => browserErrors.push(message.text()));
    page.on('pageerror', (error) => browserErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/parent`);
    await page.waitForFunction(() => document.querySelector('#results')?.textContent.includes('"ran":true'), undefined, { timeout: 5000 }).catch((error) => { throw new Error(`${error.message}; browser errors: ${browserErrors.join(' | ')}`); });
    const result = JSON.parse(await page.locator('#results').textContent());
    assert.equal(result.ran, true, 'inline JavaScript runs');
    assert.equal(result.cookie, 'blocked', 'the page cannot read cookies');
    assert.equal(result.parentReadable, false, 'the page cannot read its parent');
    assert.equal(result.fetchBlocked, true, 'connect-src blocks API and other Vault reads');
    assert.equal(result.imageBlocked, true, 'external image beacons are blocked');
    assert.equal(result.formBlocked, true, 'form submissions are blocked');
    assert.equal(result.popupBlocked, true, 'the sandbox prevents window.open');
    assert.equal(result.frameBlocked, true, 'the page cannot frame another Vault');
    for (const directive of ['connect-src', 'img-src']) assert.ok(result.blockedDirectives.includes(directive), `${directive} blocks the hostile action`);
    await page.waitForTimeout(100);
    assert.deepEqual(reached.filter((path) => path !== '/favicon.ico'), ['/parent', '/vault-pages/one/hostile.html'], 'no request reaches the API, collector, external image or another Vault');
  } finally {
    await browser.close();
    server.close();
    await once(server, 'close');
  }
});
