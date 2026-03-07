import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { URL } from 'node:url';

import { readCurrentProject, saveCurrentProject } from './lib/project-store.mjs';
import { ensureDirectoryPath, selectProjectFolder } from './lib/folder-dialog.mjs';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3210);
const webRoot = path.resolve(process.cwd(), 'source/web');

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function sendNoContent(response) {
  response.writeHead(204, { 'Cache-Control': 'no-store' });
  response.end();
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) {
    return {};
  }

  return JSON.parse(raw);
}

async function serveStatic(requestUrl, response) {
  const pathname = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
  const safePath = path.normalize(pathname).replace(/^(\.\.(?:[\\/]|$))+/, '');
  const filePath = path.join(webRoot, safePath);

  if (!filePath.startsWith(webRoot)) {
    sendJson(response, 403, { error: 'Forbidden' });
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }

    const ext = path.extname(filePath);
    const contentType = contentTypes[ext] ?? 'application/octet-stream';
    const content = await fs.readFile(filePath);

    response.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
    });
    response.end(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }

    console.error(error);
    sendJson(response, 500, { error: 'Failed to serve file.' });
  }
}

async function handleProjectSelect(request, response) {
  try {
    const body = await readBody(request);
    let selectedPath = null;

    if (body.path) {
      selectedPath = await ensureDirectoryPath(path.resolve(body.path));
    } else {
      selectedPath = await selectProjectFolder();
    }

    if (!selectedPath) {
      sendJson(response, 200, { project: null, cancelled: true });
      return;
    }

    const project = await saveCurrentProject(selectedPath);
    sendJson(response, 200, { project, cancelled: false });
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: error.message || 'Failed to select project.' });
  }
}

async function requestHandler(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host ?? `${host}:${port}`}`);

  if (request.method === 'GET' && requestUrl.pathname === '/api/health') {
    sendJson(response, 200, {
      ok: true,
      app: 'SimpleKanban',
      version: '0.1.0-m1',
    });
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/project/current') {
    const project = await readCurrentProject();
    sendJson(response, 200, { project });
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/project/select') {
    await handleProjectSelect(request, response);
    return;
  }

  if (request.method === 'OPTIONS') {
    sendNoContent(response);
    return;
  }

  await serveStatic(requestUrl, response);
}

const server = http.createServer((request, response) => {
  requestHandler(request, response).catch((error) => {
    console.error(error);
    sendJson(response, 500, { error: 'Unexpected server error.' });
  });
});

server.listen(port, host, () => {
  console.log(`SimpleKanban M1 server listening on http://${host}:${port}`);
});
