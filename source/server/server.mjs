import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { URL } from 'node:url';

import WebSocket, { WebSocketServer } from 'ws';

import { buildExecutorCommand, listExecutorProfiles, normalizeExecutorParams } from './lib/executor-profiles.mjs';
import {
  readCurrentProject,
  saveCurrentProject,
  listTasks,
  createTask,
  getTask,
  updateTask,
  markInterruptedTasksLost,
} from './lib/project-store.mjs';
import { ensureDirectoryPath, selectProjectFolder } from './lib/folder-dialog.mjs';
import { createTerminalSessionManager } from './lib/terminal-session-manager.mjs';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3210);
const webRoot = path.resolve(process.cwd(), 'source/web');
const nodeModulesRoot = path.resolve(process.cwd(), 'node_modules');
const terminalSessionManager = createTerminalSessionManager();
let activeTaskSessionLink = null;

function now() {
  return new Date().toISOString();
}

async function reconcileTasksOnBoot() {
  const activeSessionId = terminalSessionManager.getSnapshot()?.id ?? null;
  const result = await markInterruptedTasksLost(activeSessionId);

  if (result.changed) {
    console.log(`[M3] Marked ${result.affectedCount} task(s) as lost on boot.`);
  }
}

function mapTaskStatusFromSessionStatus(sessionStatus) {
  if (sessionStatus === 'running' || sessionStatus === 'starting') {
    return 'running';
  }

  if (sessionStatus === 'closed' || sessionStatus === 'error') {
    return 'ended';
  }

  return 'idle';
}

function detectTaskWaitingState(output) {
  const text = String(output ?? '').toLowerCase();

  if (!text.trim()) {
    return false;
  }

  return [
    'press any key',
    'continue?',
    'password',
    'confirm',
    '[y/n]',
    '(y/n)',
    'waiting for input',
    'input required',
    'permission',
    'allow',
  ].some((keyword) => text.includes(keyword));
}

function buildPrimaryNoteAttachment(task, content) {
  const trimmedContent = String(content ?? '').trim();

  if (!trimmedContent) {
    return null;
  }

  const existingNoteAttachment = Array.isArray(task?.attachments)
    ? task.attachments.find((attachment) => attachment.type === 'note') ?? null
    : null;
  const timestamp = now();

  return {
    id: existingNoteAttachment?.id,
    type: 'note',
    relation: 'adjacent',
    order: 0,
    content: trimmedContent,
    createdAt: existingNoteAttachment?.createdAt ?? task.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

async function syncLinkedTaskWithSession(session, extras = {}) {
  if (!activeTaskSessionLink?.taskId) {
    return null;
  }

  const task = await getTask(activeTaskSessionLink.taskId);

  if (!task) {
    activeTaskSessionLink = null;
    return null;
  }

  const nextStatus = extras.status ?? (session?.status ? mapTaskStatusFromSessionStatus(session.status) : task.status);
  const nextSessionId = session?.id ?? activeTaskSessionLink.sessionId ?? task.linkedSessionId ?? null;
  const nextActivityAt = extras.lastTerminalActivityAt ?? task.lastTerminalActivityAt;
  const nextOutput = extras.lastTerminalOutput ?? task.lastTerminalOutput;

  if (
    task.status === nextStatus
    && task.linkedSessionId === nextSessionId
    && task.lastTerminalActivityAt === nextActivityAt
    && task.lastTerminalOutput === nextOutput
  ) {
    if (!session || session.status === 'closed' || session.status === 'error') {
      activeTaskSessionLink = null;
    }
    return task;
  }

  const updatedTask = await updateTask(task.id, {
    status: nextStatus,
    linkedSessionId: nextSessionId,
    lastStatusAt: now(),
    lastTerminalActivityAt: nextActivityAt,
    lastTerminalOutput: nextOutput,
  });

  if (!session || session.status === 'closed' || session.status === 'error') {
    activeTaskSessionLink = null;
  } else if (updatedTask) {
    activeTaskSessionLink = {
      taskId: updatedTask.id,
      sessionId: updatedTask.linkedSessionId,
    };
  }

  return updatedTask;
}

terminalSessionManager.subscribe((event) => {
  if (event.type === 'session') {
    syncLinkedTaskWithSession(event.session).catch((error) => {
      console.error('Failed to sync task session state.', error);
    });
    return;
  }

  if (event.type === 'output') {
    const status = detectTaskWaitingState(event.data) ? 'waiting' : undefined;
    syncLinkedTaskWithSession(terminalSessionManager.getSnapshot(), {
      status,
      lastTerminalActivityAt: event.at ?? now(),
      lastTerminalOutput: String(event.data ?? '').slice(-500),
    }).catch((error) => {
      console.error('Failed to sync task output state.', error);
    });
  }
}, { replay: false });

const vendorFiles = {
  '/vendor/xterm.css': path.join(nodeModulesRoot, '@xterm/xterm/css/xterm.css'),
  '/vendor/xterm.js': path.join(nodeModulesRoot, '@xterm/xterm/lib/xterm.js'),
  '/vendor/xterm-addon-fit.js': path.join(nodeModulesRoot, '@xterm/addon-fit/lib/addon-fit.js'),
};

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

function getContentType(filePath) {
  return contentTypes[path.extname(filePath)] ?? 'application/octet-stream';
}

async function serveFile(filePath, response, notFoundMessage = 'Not found') {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      sendJson(response, 404, { error: notFoundMessage });
      return;
    }

    const content = await fs.readFile(filePath);
    response.writeHead(200, {
      'Content-Type': getContentType(filePath),
      'Cache-Control': 'no-store',
    });
    response.end(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      sendJson(response, 404, { error: notFoundMessage });
      return;
    }

    console.error(error);
    sendJson(response, 500, { error: 'Failed to serve file.' });
  }
}

async function serveStatic(requestUrl, response) {
  const pathname = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
  const safePath = path.normalize(pathname).replace(/^(\.\.(?:[\\/]|$))+/, '');
  const filePath = path.join(webRoot, safePath);

  if (!filePath.startsWith(webRoot)) {
    sendJson(response, 403, { error: 'Forbidden' });
    return;
  }

  await serveFile(filePath, response);
}

async function serveVendorFile(requestUrl, response) {
  const filePath = vendorFiles[requestUrl.pathname];

  if (!filePath) {
    sendJson(response, 404, { error: 'Not found' });
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      sendJson(response, 404, { error: 'Vendor asset is not available.' });
      return;
    }

    const content = await fs.readFile(filePath);
    response.writeHead(200, {
      'Content-Type': getContentType(filePath),
      'Cache-Control': 'no-store',
    });
    response.end(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      sendJson(response, 503, { error: 'Vendor asset is not installed.' });
      return;
    }

    console.error(error);
    sendJson(response, 500, { error: 'Failed to serve vendor file.' });
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
    terminalSessionManager.closeIfProjectChanged(project.path);
    sendJson(response, 200, { project, cancelled: false });
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: error.message || 'Failed to select project.' });
  }
}

async function handleTerminalSnapshot(response) {
  sendJson(response, 200, { session: terminalSessionManager.getSnapshot() });
}

async function handleTerminalClose(response) {
  const session = terminalSessionManager.close();
  sendJson(response, 200, { session });
}

async function handleTaskList(response) {
  const tasks = await listTasks();
  sendJson(response, 200, { tasks });
}

async function handleTaskCreate(request, response) {
  try {
    const body = await readBody(request);
    const task = await createTask({
      title: body.title,
      description: body.description,
      executorId: body.executorId,
    });
    sendJson(response, 201, { task });
  } catch (error) {
    const statusCode = /required/i.test(error.message) ? 400 : 500;
    sendJson(response, statusCode, { error: error.message || 'Failed to create task.' });
  }
}

async function handleTaskNoteUpdate(request, response) {
  try {
    const body = await readBody(request);
    const taskId = String(body.taskId ?? '').trim();

    if (!taskId) {
      sendJson(response, 400, { error: 'taskId is required.' });
      return;
    }

    const task = await getTask(taskId);

    if (!task) {
      sendJson(response, 404, { error: 'Task not found.' });
      return;
    }

    const taskNoteContent = body.content == null ? '' : String(body.content);
    const nextPrimaryNoteAttachment = buildPrimaryNoteAttachment(task, taskNoteContent);
    const attachments = Array.isArray(task.attachments)
      ? task.attachments.filter((attachment) => attachment.type !== 'note')
      : [];

    if (nextPrimaryNoteAttachment) {
      attachments.unshift(nextPrimaryNoteAttachment);
    }

    const updatedTask = await updateTask(task.id, {
      attachments,
    });

    sendJson(response, 200, { task: updatedTask });
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: error.message || 'Failed to save task note.' });
  }
}

async function handleTaskDependenciesUpdate(request, response) {
  try {
    const body = await readBody(request);
    const taskId = String(body.taskId ?? '').trim();

    if (!taskId) {
      sendJson(response, 400, { error: 'taskId is required.' });
      return;
    }

    const task = await getTask(taskId);

    if (!task) {
      sendJson(response, 404, { error: 'Task not found.' });
      return;
    }

    const allTasks = await listTasks();
    const allowedIds = new Set(allTasks.map((item) => item.id));
    const rawDependencyIds = Array.isArray(body.dependencyIds) ? body.dependencyIds : [];
    const dependencyIds = [];
    const seen = new Set();

    for (const item of rawDependencyIds) {
      const id = String(item ?? '').trim();

      if (!id) {
        continue;
      }

      if (id === taskId) {
        continue;
      }

      if (!allowedIds.has(id)) {
        continue;
      }

      if (seen.has(id)) {
        continue;
      }

      seen.add(id);
      dependencyIds.push(id);

      if (dependencyIds.length >= 50) {
        break;
      }
    }

    const updatedTask = await updateTask(taskId, {
      dependencyIds,
    });

    sendJson(response, 200, { task: updatedTask });
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: error.message || 'Failed to update task dependencies.' });
  }
}

async function handleTaskRun(request, response) {
  try {
    const body = await readBody(request);
    const taskId = String(body.taskId ?? '').trim();

    if (!taskId) {
      sendJson(response, 400, { error: 'taskId is required.' });
      return;
    }

    const task = await getTask(taskId);

    if (!task) {
      sendJson(response, 404, { error: 'Task not found.' });
      return;
    }

    const project = await ensureCurrentProject();
    const params = normalizeExecutorParams(task.executorId, body.params ?? {});
    const command = buildExecutorCommand(task.executorId, params);
    const session = terminalSessionManager.ensureActiveSession({
      projectPath: project.path,
      cols: body.cols,
      rows: body.rows,
    });

    activeTaskSessionLink = {
      taskId: task.id,
      sessionId: session.id,
    };

    const updatedTask = await updateTask(task.id, {
      status: 'running',
      linkedSessionId: session.id,
      lastRunAt: now(),
      lastStatusAt: now(),
      lastTerminalActivityAt: session.lastOutputAt ?? null,
    });

    terminalSessionManager.write(`${command}\r`);

    sendJson(response, 200, {
      task: updatedTask,
      session: terminalSessionManager.getSnapshot(),
      command,
      params,
    });
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: error.message || 'Failed to run task.' });
  }
}

async function handleExecutorList(response) {
  sendJson(response, 200, {
    executors: listExecutorProfiles(),
  });
}

async function handleExecutorPreview(request, response) {
  try {
    const body = await readBody(request);
    const executorId = String(body.executorId ?? '').trim();

    if (!executorId) {
      sendJson(response, 400, { error: 'executorId is required.' });
      return;
    }

    const params = normalizeExecutorParams(executorId, body.params ?? {});
    const command = buildExecutorCommand(executorId, params);

    sendJson(response, 200, {
      executorId,
      params,
      command,
    });
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: error.message || 'Failed to preview executor command.' });
  }
}

async function handleExecutorInject(request, response) {
  try {
    const body = await readBody(request);
    const executorId = String(body.executorId ?? '').trim();

    if (!executorId) {
      sendJson(response, 400, { error: 'executorId is required.' });
      return;
    }

    const session = terminalSessionManager.getSnapshot();

    if (!session || session.status !== 'running') {
      sendJson(response, 400, { error: '请先启动网页终端，再执行注入。' });
      return;
    }

    const params = normalizeExecutorParams(executorId, body.params ?? {});
    const command = buildExecutorCommand(executorId, params);
    terminalSessionManager.write(`${command}\r`);

    sendJson(response, 200, {
      executorId,
      params,
      command,
      session: terminalSessionManager.getSnapshot(),
    });
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: error.message || 'Failed to inject executor command.' });
  }
}

async function ensureCurrentProject() {
  const project = await readCurrentProject();

  if (!project?.path) {
    throw new Error('Please select a project before starting the terminal.');
  }

  return project;
}

async function handleWebSocketMessage(socket, raw) {
  let message = null;

  try {
    message = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    socket.send(JSON.stringify({ type: 'error', message: 'Invalid terminal message.' }));
    return;
  }

  try {
    if (message.type === 'connect') {
      const project = await ensureCurrentProject();
      const session = terminalSessionManager.ensureActiveSession({
        projectPath: project.path,
        cols: message.cols,
        rows: message.rows,
      });
      socket.send(JSON.stringify({ type: 'session', session }));
      return;
    }

    if (message.type === 'input') {
      terminalSessionManager.write(String(message.data ?? ''));
      return;
    }

    if (message.type === 'resize') {
      terminalSessionManager.resize(message.cols, message.rows);
      return;
    }

    if (message.type === 'close') {
      terminalSessionManager.close();
      return;
    }

    socket.send(JSON.stringify({ type: 'error', message: `Unsupported terminal message: ${message.type}` }));
  } catch (error) {
    socket.send(JSON.stringify({ type: 'error', message: error.message || 'Terminal request failed.' }));
  }
}

async function requestHandler(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host ?? `${host}:${port}`}`);

  if (request.method === 'GET' && requestUrl.pathname === '/api/health') {
    sendJson(response, 200, {
      ok: true,
      app: 'SimpleKanban',
      version: '0.2.0-m2',
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

  if (request.method === 'GET' && requestUrl.pathname === '/api/tasks') {
    await handleTaskList(response);
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/tasks') {
    await handleTaskCreate(request, response);
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/tasks/note') {
    await handleTaskNoteUpdate(request, response);
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/tasks/dependencies') {
    await handleTaskDependenciesUpdate(request, response);
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/tasks/run') {
    await handleTaskRun(request, response);
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/executors') {
    await handleExecutorList(response);
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/executors/preview') {
    await handleExecutorPreview(request, response);
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/terminal/session') {
    await handleTerminalSnapshot(response);
    return;
  }

  if (
    request.method === 'POST'
    && (requestUrl.pathname === '/api/executors/inject' || requestUrl.pathname === '/api/executors/run')
  ) {
    await handleExecutorInject(request, response);
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/terminal/close') {
    await handleTerminalClose(response);
    return;
  }

  if (request.method === 'OPTIONS') {
    sendNoContent(response);
    return;
  }

  if (requestUrl.pathname.startsWith('/vendor/')) {
    await serveVendorFile(requestUrl, response);
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

const webSocketServer = new WebSocketServer({ noServer: true });

webSocketServer.on('connection', (socket) => {
  const unsubscribe = terminalSessionManager.subscribe((event) => {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(JSON.stringify(event));
  });

  socket.on('message', (raw) => {
    handleWebSocketMessage(socket, raw).catch((error) => {
      console.error(error);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'error', message: 'Unexpected terminal error.' }));
      }
    });
  });

  socket.on('close', () => {
    unsubscribe();
  });
});

server.on('upgrade', (request, socket, head) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host ?? `${host}:${port}`}`);

  if (requestUrl.pathname !== '/ws/terminal') {
    socket.destroy();
    return;
  }

  webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
    webSocketServer.emit('connection', webSocket, request);
  });
});

function shutdown() {
  terminalSessionManager.close();
  webSocketServer.close();
  server.close();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await reconcileTasksOnBoot();

server.listen(port, host, () => {
  console.log(`SimpleKanban M2 server listening on http://${host}:${port}`);
});
