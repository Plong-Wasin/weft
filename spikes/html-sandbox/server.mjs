import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
export function createSandboxServer({
  egressOrigin = 'http://127.0.0.1:9',
  onProbe = () => {},
  stunServerUrl = 'stun:127.0.0.1:9',
} = {}) {
  return createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/sandbox-spike') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': [
          'weft_session=spike-session; HttpOnly; SameSite=Strict; Path=/',
          'weft_csrf=spike-csrf; SameSite=Strict; Path=/',
        ],
      });
      response.end(await readFile(join(directory, 'app.html')));
      return;
    }
    if (path === '/vault-pages/spike.html') {
      const appOrigin = new URL(request.url, `http://${request.headers.host}`).origin;
      const csp = `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline' 'self'; img-src ${appOrigin} data:; connect-src 'none'; form-action 'none'`;
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': csp,
        'x-content-type-options': 'nosniff',
      });
      const html = (await readFile(join(directory, 'vault-page.html'), 'utf8'))
        .replaceAll('__STUN_SERVER__', stunServerUrl)
        .replaceAll('__EGRESS_ORIGIN__', egressOrigin);
      response.end(html);
      return;
    }
    if (path === '/api/v1') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end('{"service":"spike-api"}');
      return;
    }
    if (path === '/probe-target') {
      onProbe(request);
      response.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store' });
      response.end(Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64'));
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found');
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createSandboxServer();
  const port = Number(process.env.PORT ?? 4179);
  server.listen(port, '127.0.0.1', () => {
    console.log(`HTML sandbox spike at http://127.0.0.1:${port}/sandbox-spike`);
  });
}
