import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { createSandboxServer } from './server.mjs';
import { chromium, firefox, webkit } from 'playwright';

let server;
let stunServer;
let egressServer;
let origin;
let stunPackets = 0;
const egressRequests = [];
const sameOriginProbes = [];

before(async () => {
  egressServer = createServer((request, response) => {
    egressRequests.push(request.url);
    response.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store' });
    response.end(Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64'));
  });
  await new Promise((resolve) => egressServer.listen(0, '127.0.0.1', resolve));
  const egressOrigin = `http://127.0.0.1:${egressServer.address().port}`;
  stunServer = createSocket('udp4');
  stunServer.on('message', () => { stunPackets += 1; });
  await new Promise((resolve) => stunServer.bind(0, '127.0.0.1', resolve));
  const stunServerUrl = `stun:127.0.0.1:${stunServer.address().port}`;
  server = createSandboxServer({
    egressOrigin,
    onProbe: (request) => sameOriginProbes.push({ path: request.url, cookie: request.headers.cookie ?? null }),
    stunServerUrl,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await new Promise((resolve, reject) => stunServer.close((error) => error ? reject(error) : resolve()));
  await new Promise((resolve, reject) => egressServer.close((error) => error ? reject(error) : resolve()));
});

for (const [name, engine] of [['Chromium', chromium], ['Firefox', firefox], ['WebKit', webkit]]) {
  test(`${name} enforces the same-origin HTML sandbox boundary`, async (context) => {
    let browser;
    try {
      const executablePath = process.env[`WEFT_${name.toUpperCase()}_PATH`];
      browser = await engine.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    } catch (error) {
      context.skip(`${name} browser is not installed: ${error.message}`);
      return;
    }
    try {
      const page = await browser.newPage();
      const requests = [];
      const egressStart = egressRequests.length;
      const stunStart = stunPackets;
      const probeStart = sameOriginProbes.length;
      page.on('request', (request) => requests.push(request.url()));
      await page.goto(`${origin}/sandbox-spike`);
      const cookies = await page.context().cookies(origin);
      assert.deepEqual(cookies.map((cookie) => cookie.name).sort(), ['weft_csrf', 'weft_session']);
      const frame = page.frames().find((candidate) => candidate.url().includes('/vault-pages/spike.html'));
      assert.ok(frame, `${name} loads the separately routed Vault page`);
      await frame.locator('form button').click();
      await frame.waitForFunction(() => {
        const probe = JSON.parse(document.querySelector('#results').textContent);
        return probe.apiFetch === 'blocked'
          && probe.externalFetch === 'blocked'
          && probe.webSocket !== 'pending'
          && probe.imageLoad !== undefined
          && probe.externalImageLoad !== undefined;
      });
      const webrtcDeadline = Date.now() + 3000;
      while (stunPackets === stunStart && Date.now() < webrtcDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const probe = JSON.parse(await frame.locator('#results').textContent());

      assert.match(probe.documentCookie, /^SecurityError: blocked$/, 'sandboxed scripts cannot read app cookies');
      assert.match(probe.parentRead, /^SecurityError: blocked$/);
      assert.equal(probe.parentMessage, 'sent', 'sandboxed scripts can still send untrusted postMessage events');
      assert.deepEqual(await page.evaluate(() => window.__sandboxMessages), [{ type: 'sandbox-spike-message' }]);
      assert.equal(probe.apiFetch, 'blocked');
      assert.equal(probe.externalFetch, 'blocked');
      assert.equal(probe.externalImageLoad, 'blocked');
      assert.equal(probe.imageLoad, 'loaded', 'same-origin image assets work in all supported engines');
      assert.match(probe.windowOpen, /^(?:[A-Za-z]+Error: )?blocked$/);
      assert.match(probe.topNavigation, /^SecurityError: blocked$/);
      assert.ok(requests.some((url) => url.includes('/probe-target?via=image')), 'same-origin image load reaches the server');
      assert.ok(!egressRequests.slice(egressStart).some((url) => url.includes('via=form')), 'form action does not reach the other origin');
      assert.ok(!egressRequests.slice(egressStart).some((url) => url.includes('via=fetch')), 'fetch does not reach the other origin');
      assert.ok(!egressRequests.slice(egressStart).some((url) => url.includes('via=external-image')), 'external image does not reach the other origin');
      assert.ok(!requests.some((url) => url.includes('via=websocket')), 'WebSocket handshake does not reach the server');
      assert.ok(!requests.some((url) => url.includes('via=top-navigation')), 'top navigation does not reach the app');
      assert.ok(stunPackets > stunStart, 'a local STUN endpoint receives WebRTC traffic despite the CSP');
      context.diagnostic(`${name} ${browser.version()}: ${JSON.stringify({
        ...probe,
        webRtcStunPackets: stunPackets - stunStart,
        sameOriginRequests: requests.filter((url) => url.includes('probe-target')),
        sameOriginServerProbes: sameOriginProbes.slice(probeStart),
        otherOriginRequests: egressRequests.slice(egressStart),
      })}`);

      // Direct navigation retains the response-level sandbox and blocks network APIs.
      const direct = await page.goto(`${origin}/vault-pages/spike.html`);
      assert.match(direct.headers()['content-security-policy'], /^sandbox allow-scripts;/);
      const directProbe = JSON.parse(await page.locator('#results').textContent());
      assert.match(directProbe.documentCookie, /^SecurityError: blocked$/, 'direct navigation keeps the response-level sandbox');
      assert.equal(directProbe.topNavigation, 'no parent browsing context');
      assert.equal(directProbe.apiFetch, 'blocked');
      assert.equal(directProbe.externalFetch, 'blocked');
      assert.equal(directProbe.externalImageLoad, 'blocked');
      assert.match(directProbe.windowOpen, /^(?:[A-Za-z]+Error: )?blocked$/);
    } finally {
      await browser.close();
    }
  });
}
