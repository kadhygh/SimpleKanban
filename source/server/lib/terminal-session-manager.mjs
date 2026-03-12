import crypto from 'node:crypto';

import pty from 'node-pty';

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const OUTPUT_BUFFER_LIMIT = 200;
const SESSION_LIMIT = 3;
const ACTIVE_SESSION_STATUSES = new Set(['starting', 'running', 'waiting']);

function now() {
  return new Date().toISOString();
}

function clampSize(value, fallback) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.max(1, Math.floor(number));
}

function resolveShell() {
  if (process.env.PTY_SHELL) {
    return {
      shell: process.env.PTY_SHELL,
      args: [],
    };
  }

  if (process.platform === 'win32') {
    return {
      shell: 'powershell.exe',
      args: ['-NoLogo'],
    };
  }

  return {
    shell: process.env.SHELL || 'bash',
    args: [],
  };
}

function withRuntimeStatus(session) {
  if (!session) {
    return null;
  }

  return {
    ...session,
    runtimeStatus: session.status,
  };
}

function isSessionActive(session) {
  return Boolean(session && ACTIVE_SESSION_STATUSES.has(session.status));
}

export function createTerminalSessionManager() {
  const sessions = new Map();
  const globalListeners = new Set();
  let nextSessionNameIndex = 1;

  function listEntries() {
    return [...sessions.values()].sort((left, right) => {
      const leftTime = Date.parse(left.session.createdAt ?? '') || 0;
      const rightTime = Date.parse(right.session.createdAt ?? '') || 0;
      return rightTime - leftTime;
    });
  }

  function getEntry(sessionId) {
    if (!sessionId) {
      return null;
    }

    return sessions.get(String(sessionId)) ?? null;
  }

  function getSnapshot(sessionId) {
    if (!sessionId) {
      return null;
    }

    return withRuntimeStatus(getEntry(sessionId)?.session ?? null);
  }

  function listSnapshots() {
    return listEntries().map((entry) => withRuntimeStatus(entry.session));
  }

  function emit(entry, event) {
    if (!entry) {
      return;
    }

    if (event.type === 'output') {
      entry.recentEvents.push(event);
      if (entry.recentEvents.length > OUTPUT_BUFFER_LIMIT) {
        entry.recentEvents = entry.recentEvents.slice(-OUTPUT_BUFFER_LIMIT);
      }
    }

    for (const listener of entry.listeners) {
      listener(event);
    }

    for (const listener of globalListeners) {
      listener(event);
    }
  }

  function publishEvent(sessionId, event) {
    const entry = getEntry(sessionId);

    if (!entry) {
      throw new Error('Session not found.');
    }

    emit(entry, {
      ...event,
      sessionId: entry.session.id,
    });
  }

  function emitSession(entry) {
    emit(entry, { type: 'session', session: withRuntimeStatus(entry.session) });
  }

  function updateSession(entry, patch) {
    if (!entry) {
      return null;
    }

    entry.session = {
      ...entry.session,
      ...patch,
    };

    emitSession(entry);
    return withRuntimeStatus(entry.session);
  }

  function disposePty(entry) {
    if (!entry?.pty) {
      return;
    }

    entry.pty.removeAllListeners?.();
    entry.pty = null;
  }

  function nextSessionName() {
    const value = `Session ${nextSessionNameIndex}`;
    nextSessionNameIndex += 1;
    return value;
  }

  function getActiveSessionCount() {
    return listEntries().filter((entry) => isSessionActive(entry.session)).length;
  }

  function subscribe(sessionId, listener, options = {}) {
    const entry = getEntry(sessionId);

    if (!entry) {
      throw new Error('Session not found.');
    }

    entry.listeners.add(listener);

    if (options.replay !== false) {
      listener({ type: 'session', session: withRuntimeStatus(entry.session) });
      for (const event of entry.recentEvents) {
        listener(event);
      }
    }

    return () => {
      entry.listeners.delete(listener);
    };
  }

  function subscribeAll(listener) {
    globalListeners.add(listener);

    return () => {
      globalListeners.delete(listener);
    };
  }

  function createSession(options = {}) {
    const projectPath = String(options.projectPath ?? '').trim();
    const workdir = String(options.workdir ?? projectPath).trim();
    const cols = clampSize(options.cols, DEFAULT_COLS);
    const rows = clampSize(options.rows, DEFAULT_ROWS);

    if (!projectPath) {
      throw new Error('Current project is required before starting a terminal session.');
    }

    if (!workdir) {
      throw new Error('Session workdir is required.');
    }

    if (getActiveSessionCount() >= SESSION_LIMIT) {
      throw new Error(`最多只能同时保留 ${SESSION_LIMIT} 个活跃 Session。`);
    }

    const shellConfig = resolveShell();
    const createdAt = now();
    const sessionId = crypto.randomUUID();
    const entry = {
      pty: null,
      recentEvents: [],
      listeners: new Set(),
      session: {
        id: sessionId,
        name: String(options.name ?? '').trim() || nextSessionName(),
        projectPath,
        workdir,
        cwd: workdir,
        shell: shellConfig.shell,
        pid: null,
        cols,
        rows,
        status: 'starting',
        createdAt,
        startedAt: createdAt,
        endedAt: null,
        lastOutputAt: null,
        exitCode: null,
        error: null,
      },
    };

    sessions.set(sessionId, entry);
    emitSession(entry);

    try {
      entry.pty = pty.spawn(shellConfig.shell, shellConfig.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: workdir,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
        },
      });
    } catch (error) {
      entry.session = {
        ...entry.session,
        status: 'error',
        endedAt: now(),
        error: error.message || 'Failed to start PTY session.',
      };
      emitSession(entry);
      throw error;
    }

    updateSession(entry, {
      pid: entry.pty.pid,
      status: 'running',
      error: null,
    });

    entry.pty.onData((data) => {
      const timestamp = now();
      entry.session = {
        ...entry.session,
        lastOutputAt: timestamp,
      };

      emit(entry, {
        type: 'output',
        sessionId,
        data,
        at: timestamp,
      });
    });

    entry.pty.onExit(({ exitCode, signal }) => {
      if (entry.pty) {
        disposePty(entry);
      }

      entry.session = {
        ...entry.session,
        status: 'closed',
        endedAt: now(),
        exitCode,
      };

      emit(entry, {
        type: 'exit',
        sessionId,
        exitCode,
        signal,
        session: withRuntimeStatus(entry.session),
      });
      emitSession(entry);
    });

    return withRuntimeStatus(entry.session);
  }

  function write(sessionId, data) {
    const entry = getEntry(sessionId);

    if (!entry?.pty || !isSessionActive(entry.session)) {
      throw new Error('Terminal session is not running.');
    }

    if (entry.session.status === 'waiting') {
      updateSession(entry, {
        status: 'running',
      });
    }

    entry.pty.write(data);
  }

  function resize(sessionId, cols, rows) {
    const entry = getEntry(sessionId);

    if (!entry) {
      throw new Error('Session not found.');
    }

    const nextCols = clampSize(cols, DEFAULT_COLS);
    const nextRows = clampSize(rows, DEFAULT_ROWS);

    entry.session = {
      ...entry.session,
      cols: nextCols,
      rows: nextRows,
    };
    emitSession(entry);

    if (entry.pty) {
      entry.pty.resize(nextCols, nextRows);
    }

    return withRuntimeStatus(entry.session);
  }

  function patchSession(sessionId, patch) {
    const entry = getEntry(sessionId);

    if (!entry) {
      throw new Error('Session not found.');
    }

    return updateSession(entry, patch);
  }

  function close(sessionId) {
    const entry = getEntry(sessionId);

    if (!entry) {
      return null;
    }

    if (!entry.pty) {
      return withRuntimeStatus(entry.session);
    }

    entry.pty.kill();
    return withRuntimeStatus(entry.session);
  }

  function closeAll() {
    for (const entry of listEntries()) {
      close(entry.session.id);
    }
  }

  function closeIfProjectChanged(projectPath) {
    for (const entry of listEntries()) {
      if (entry.session.projectPath === projectPath) {
        continue;
      }

      close(entry.session.id);
    }
  }

  return {
    close,
    closeAll,
    closeIfProjectChanged,
    createSession,
    getSnapshot,
    listSnapshots,
    patchSession,
    publishEvent,
    resize,
    subscribe,
    subscribeAll,
    write,
  };
}
