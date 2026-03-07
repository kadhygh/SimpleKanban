import crypto from 'node:crypto';

import pty from 'node-pty';

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const OUTPUT_BUFFER_LIMIT = 200;

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

export function createTerminalSessionManager() {
  let activePty = null;
  let session = null;
  let recentEvents = [];
  const listeners = new Set();

  function getSnapshot() {
    if (!session) {
      return null;
    }

    return { ...session };
  }

  function emit(event) {
    if (event.type === 'output') {
      recentEvents.push(event);
      if (recentEvents.length > OUTPUT_BUFFER_LIMIT) {
        recentEvents = recentEvents.slice(-OUTPUT_BUFFER_LIMIT);
      }
    }

    for (const listener of listeners) {
      listener(event);
    }
  }

  function emitSession() {
    emit({ type: 'session', session: getSnapshot() });
  }

  function updateSession(patch) {
    if (!session) {
      return;
    }

    session = {
      ...session,
      ...patch,
    };

    emitSession();
  }

  function disposeActivePty() {
    if (!activePty) {
      return;
    }

    activePty.removeAllListeners?.();
    activePty = null;
  }

  function subscribe(listener, options = {}) {
    listeners.add(listener);

    if (options.replay !== false) {
      listener({ type: 'session', session: getSnapshot() });
      for (const event of recentEvents) {
        listener(event);
      }
    }

    return () => {
      listeners.delete(listener);
    };
  }

  function ensureActiveSession(options) {
    const projectPath = options.projectPath;
    const cols = clampSize(options.cols, DEFAULT_COLS);
    const rows = clampSize(options.rows, DEFAULT_ROWS);

    if (!projectPath) {
      throw new Error('Current project is required before starting a terminal session.');
    }

    if (activePty && session?.status === 'running' && session.projectPath === projectPath) {
      resize(cols, rows);
      return getSnapshot();
    }

    if (activePty) {
      close();
    }

    recentEvents = [];

    const shellConfig = resolveShell();
    const createdAt = now();
    const nextSession = {
      id: crypto.randomUUID(),
      projectPath,
      cwd: projectPath,
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
    };

    session = nextSession;
    emitSession();

    const sessionId = nextSession.id;

    let terminal = null;

    try {
      terminal = pty.spawn(shellConfig.shell, shellConfig.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: projectPath,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
        },
      });
    } catch (error) {
      session = {
        ...nextSession,
        status: 'error',
        endedAt: now(),
        error: error.message || 'Failed to start PTY session.',
      };

      emitSession();
      throw error;
    }

    activePty = terminal;
    updateSession({
      pid: terminal.pid,
      status: 'running',
      error: null,
    });

    terminal.onData((data) => {
      if (!session || session.id !== sessionId) {
        return;
      }

      const timestamp = now();
      session = {
        ...session,
        lastOutputAt: timestamp,
      };

      emit({
        type: 'output',
        data,
        at: timestamp,
      });
    });

    terminal.onExit(({ exitCode, signal }) => {
      if (activePty === terminal) {
        disposeActivePty();
      }

      if (!session || session.id !== sessionId) {
        return;
      }

      session = {
        ...session,
        status: 'closed',
        endedAt: now(),
        exitCode,
      };

      emit({ type: 'exit', exitCode, signal });
      emitSession();
    });

    return getSnapshot();
  }

  function write(data) {
    if (!activePty || !session || session.status !== 'running') {
      throw new Error('Terminal session is not running.');
    }

    activePty.write(data);
  }

  function resize(cols, rows) {
    const nextCols = clampSize(cols, DEFAULT_COLS);
    const nextRows = clampSize(rows, DEFAULT_ROWS);

    if (session) {
      session = {
        ...session,
        cols: nextCols,
        rows: nextRows,
      };
      emitSession();
    }

    if (activePty) {
      activePty.resize(nextCols, nextRows);
    }
  }

  function close() {
    if (!activePty) {
      return getSnapshot();
    }

    activePty.kill();
    return getSnapshot();
  }

  function closeIfProjectChanged(projectPath) {
    if (!session || session.projectPath === projectPath) {
      return;
    }

    close();
  }

  return {
    close,
    closeIfProjectChanged,
    ensureActiveSession,
    getSnapshot,
    resize,
    subscribe,
    write,
  };
}
