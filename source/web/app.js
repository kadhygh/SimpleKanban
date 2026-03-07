const healthStatus = document.querySelector('#health-status');
const apiVersion = document.querySelector('#api-version');
const projectPath = document.querySelector('#project-path');
const projectName = document.querySelector('#project-name');
const statusLog = document.querySelector('#status-log');
const selectProjectButton = document.querySelector('#select-project');
const refreshProjectButton = document.querySelector('#refresh-project');
const openTerminalButton = document.querySelector('#open-terminal');
const reconnectTerminalButton = document.querySelector('#reconnect-terminal');
const terminalConn = document.querySelector('#terminal-conn');
const terminalSession = document.querySelector('#terminal-session');
const terminalSize = document.querySelector('#terminal-size');
const terminalPanel = document.querySelector('#terminal-panel');
const terminalRoot = document.querySelector('#terminal-root');
const executorSelect = document.querySelector('#executor-select');
const executorStatus = document.querySelector('#executor-status');
const executorDescription = document.querySelector('#executor-description');
const executorCommand = document.querySelector('#executor-command');
const refreshExecutorsButton = document.querySelector('#refresh-executors');
const runExecutorButton = document.querySelector('#run-executor');

const { Terminal } = window;
const FitAddonCtor = window.FitAddon?.FitAddon;

let currentProject = null;
let currentSession = null;
let terminal = null;
let fitAddon = null;
let socket = null;
let resizeObserver = null;
let resizeTimer = null;
let executors = [];
let selectedExecutorId = null;
let lastKnownTerminalSize = {
  cols: null,
  rows: null,
};

function appendLog(message, tone = '') {
  const timestamp = new Date().toLocaleTimeString();
  const line = `[${timestamp}] ${message}`;
  statusLog.textContent = `${line}\n${statusLog.textContent}`.trim();

  if (tone) {
    healthStatus.className = tone;
  }
}

function setTerminalConnectionState(text, tone = '') {
  terminalConn.textContent = text;
  terminalConn.className = tone;
}

function setExecutorStatus(text, tone = '') {
  executorStatus.textContent = text;
  executorStatus.className = tone;
}

function getSelectedExecutor() {
  return executors.find((executor) => executor.id === selectedExecutorId) ?? null;
}

function getExecutorPreview(executor) {
  if (!executor) {
    return '等待加载命令预览。';
  }

  return executor.commandPreview ?? executor.previewCommand ?? executor.command ?? '当前执行器未提供命令预览。';
}

function updateExecutorControls() {
  const hasProject = Boolean(currentProject?.path);
  const hasExecutors = executors.length > 0;
  const hasRunningTerminal = currentSession?.status === 'running';

  executorSelect.disabled = !hasExecutors;
  refreshExecutorsButton.disabled = !hasProject;
  runExecutorButton.disabled = !hasProject || !hasExecutors;

  if (!hasProject) {
    setExecutorStatus('请先选择工程', 'warn');
    return;
  }

  if (!hasExecutors) {
    setExecutorStatus('未加载执行器', 'warn');
    return;
  }

  if (!hasRunningTerminal) {
    setExecutorStatus('请先启动终端', 'warn');
    return;
  }

  setExecutorStatus('可注入', 'success');
}

function renderProject(project) {
  currentProject = project ?? null;

  if (!project) {
    projectPath.textContent = '尚未选择工程目录';
    projectName.textContent = '点击“选择工程”后，服务会保存当前项目路径。';
    openTerminalButton.disabled = true;
    reconnectTerminalButton.disabled = true;
    updateExecutorControls();
    return;
  }

  projectPath.textContent = project.path;
  projectName.textContent = `项目名称：${project.name}`;
  openTerminalButton.disabled = false;
  reconnectTerminalButton.disabled = false;
  updateExecutorControls();
}

function renderSession(session) {
  currentSession = session ?? null;

  if (!session) {
    terminalSession.textContent = '未创建';
    terminalSession.className = '';
    terminalSize.textContent = '-- x --';
    updateExecutorControls();
    return;
  }

  terminalSession.textContent = `${session.status} · ${session.id.slice(0, 8)}`;
  terminalSession.className = session.status === 'running' ? 'success' : 'warn';
  terminalSize.textContent = `${session.cols} x ${session.rows}`;
  lastKnownTerminalSize = {
    cols: session.cols,
    rows: session.rows,
  };
  updateExecutorControls();
}

function renderExecutors() {
  executorSelect.innerHTML = '';

  if (executors.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '暂无可用执行器';
    executorSelect.append(option);
    selectedExecutorId = null;
    executorDescription.textContent = currentProject?.path ? '当前项目下还没有可用执行器。' : '请先选择工程目录。';
    executorCommand.textContent = '等待加载命令预览。';
    updateExecutorControls();
    return;
  }

  for (const executor of executors) {
    const option = document.createElement('option');
    option.value = executor.id;
    option.textContent = executor.name;
    executorSelect.append(option);
  }

  if (!executors.some((executor) => executor.id === selectedExecutorId)) {
    selectedExecutorId = executors[0].id;
  }

  executorSelect.value = selectedExecutorId;
  const selectedExecutor = getSelectedExecutor();
  executorDescription.textContent = selectedExecutor?.description ?? '当前执行器未提供简介。';
  executorCommand.textContent = getExecutorPreview(selectedExecutor);
  updateExecutorControls();
}

function syncTerminalSize({ notifyServer = false } = {}) {
  if (!terminal || !fitAddon) {
    return;
  }

  fitAddon.fit();

  const nextSize = {
    cols: terminal.cols,
    rows: terminal.rows,
  };

  terminalSize.textContent = `${nextSize.cols} x ${nextSize.rows}`;

  const changed = nextSize.cols !== lastKnownTerminalSize.cols || nextSize.rows !== lastKnownTerminalSize.rows;
  lastKnownTerminalSize = nextSize;

  if (!changed || !notifyServer || socket?.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify({
    type: 'resize',
    cols: nextSize.cols,
    rows: nextSize.rows,
  }));
}

function ensureTerminal() {
  if (terminal) {
    return terminal;
  }

  if (!Terminal || !FitAddonCtor) {
    throw new Error('xterm.js 资源未就绪，请确认依赖已安装。');
  }

  terminal = new Terminal({
    cursorBlink: true,
    fontFamily: 'Consolas, Monaco, monospace',
    fontSize: 14,
    theme: {
      background: '#0c0e13',
      foreground: '#eef2ff',
    },
  });
  fitAddon = new FitAddonCtor();
  terminal.loadAddon(fitAddon);
  terminal.open(terminalRoot);
  syncTerminalSize();
  terminal.focus();

  terminal.onData((data) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(JSON.stringify({ type: 'input', data }));
  });

  resizeObserver = new ResizeObserver(() => {
    if (!fitAddon || !terminal) {
      return;
    }

    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      syncTerminalSize({ notifyServer: true });
    }, 80);
  });

  resizeObserver.observe(terminalPanel);
  return terminal;
}

function disconnectTerminal() {
  if (socket) {
    socket.close();
    socket = null;
  }
}

function connectTerminal(mode = 'connect') {
  if (!currentProject?.path) {
    appendLog('请先选择工程目录，再启动网页终端。', 'warn');
    return;
  }

  ensureTerminal();
  disconnectTerminal();

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/terminal`;

  setTerminalConnectionState('连接中...', 'warn');
  socket = new WebSocket(wsUrl);

  socket.addEventListener('open', () => {
    setTerminalConnectionState('已连接', 'success');
    if (mode === 'restore') {
      appendLog('已恢复网页终端连接。', 'success');
    } else {
      appendLog(mode === 'reconnect' ? '网页终端已重连。' : '网页终端已连接。', 'success');
    }

    syncTerminalSize();
    socket.send(JSON.stringify({
      type: 'connect',
      cols: terminal.cols,
      rows: terminal.rows,
    }));
  });

  socket.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);

    if (payload.type === 'session') {
      renderSession(payload.session);

      if (payload.recentOutput) {
        terminal.write(payload.recentOutput);
      }

      return;
    }

    if (payload.type === 'output') {
      terminal.write(payload.data);
      return;
    }

    if (payload.type === 'exit') {
      renderSession(payload.session ?? null);
      appendLog(`终端已退出，exitCode=${payload.exitCode ?? 'null'}`, 'warn');
      terminal.writeln('');
      terminal.writeln('[Terminal exited]');
      return;
    }

    if (payload.type === 'error') {
      appendLog(`终端错误：${payload.message}`, 'warn');
      terminal.writeln('');
      terminal.writeln(`[Error] ${payload.message}`);
    }
  });

  socket.addEventListener('close', () => {
    setTerminalConnectionState('已断开', 'warn');
    updateExecutorControls();
  });

  socket.addEventListener('error', () => {
    setTerminalConnectionState('连接失败', 'warn');
    appendLog('网页终端连接失败。', 'warn');
  });
}

function tryRestoreRunningSession(session) {
  if (!session || session.status !== 'running') {
    return;
  }

  if (!currentProject?.path || session.projectPath !== currentProject.path) {
    return;
  }

  connectTerminal('restore');
}

async function loadHealth() {
  try {
    const response = await fetch('/api/health', { cache: 'no-store' });
    const payload = await response.json();

    healthStatus.textContent = payload.ok ? '已连接' : '异常';
    healthStatus.className = payload.ok ? 'success' : 'warn';
    apiVersion.textContent = payload.version;
    appendLog(`服务健康检查完成：${payload.app} ${payload.version}`);
  } catch (error) {
    healthStatus.textContent = '连接失败';
    healthStatus.className = 'warn';
    apiVersion.textContent = '不可用';
    appendLog(`服务健康检查失败：${error.message}`, 'warn');
  }
}

async function loadCurrentProject() {
  try {
    const response = await fetch('/api/project/current', { cache: 'no-store' });
    const payload = await response.json();
    renderProject(payload.project);

    if (payload.project) {
      appendLog(`已加载当前项目：${payload.project.path}`);
    } else {
      appendLog('当前尚未配置项目目录。', 'warn');
    }
  } catch (error) {
    appendLog(`读取当前项目失败：${error.message}`, 'warn');
  }
}

async function loadTerminalSession() {
  try {
    const response = await fetch('/api/terminal/session', { cache: 'no-store' });
    const payload = await response.json();
    renderSession(payload.session);
    return payload.session ?? null;
  } catch (error) {
    appendLog(`读取终端快照失败：${error.message}`, 'warn');
    return null;
  }
}

async function loadExecutors() {
  if (!currentProject?.path) {
    executors = [];
    renderExecutors();
    return;
  }

  refreshExecutorsButton.disabled = true;

  try {
    const response = await fetch('/api/executors', { cache: 'no-store' });
    const payload = await response.json();
    executors = payload.executors ?? [];
    renderExecutors();
    appendLog(`已加载执行器：${executors.length} 个。`);
  } catch (error) {
    executors = [];
    renderExecutors();
    appendLog(`读取执行器列表失败：${error.message}`, 'warn');
  } finally {
    refreshExecutorsButton.disabled = false;
    updateExecutorControls();
  }
}

async function runExecutor() {
  const selectedExecutor = getSelectedExecutor();

  if (!selectedExecutor) {
    appendLog('当前没有可执行的执行器。', 'warn');
    return;
  }

  if (currentSession?.status !== 'running') {
    appendLog('请先启动网页终端，再注入执行器命令。', 'warn');
    setExecutorStatus('请先启动终端', 'warn');
    return;
  }

  runExecutorButton.disabled = true;

  try {
    const response = await fetch('/api/executors/run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ executorId: selectedExecutor.id }),
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error ?? '执行器注入失败');
    }

    executorCommand.textContent = payload.command ?? getExecutorPreview(selectedExecutor);
    appendLog(`已将执行器“${selectedExecutor.name}”注入终端。`, 'success');
    setExecutorStatus('已注入', 'success');
    terminal?.focus();
  } catch (error) {
    appendLog(`执行器注入失败：${error.message}`, 'warn');
    setExecutorStatus('注入失败', 'warn');
  } finally {
    runExecutorButton.disabled = false;
    updateExecutorControls();
  }
}

async function selectProject() {
  selectProjectButton.disabled = true;
  selectProjectButton.textContent = '选择中...';
  appendLog('正在打开本地文件夹选择窗口...');

  try {
    const response = await fetch('/api/project/select', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    const payload = await response.json();

    if (payload.cancelled) {
      appendLog('已取消工程目录选择。', 'warn');
      return;
    }

    renderProject(payload.project);
    await loadExecutors();
    appendLog(`工程目录已更新：${payload.project.path}`, 'success');
  } catch (error) {
    appendLog(`选择工程目录失败：${error.message}`, 'warn');
  } finally {
    selectProjectButton.disabled = false;
    selectProjectButton.textContent = '选择工程';
  }
}

executorSelect.addEventListener('change', () => {
  selectedExecutorId = executorSelect.value;
  const selectedExecutor = getSelectedExecutor();
  executorDescription.textContent = selectedExecutor?.description ?? '当前执行器未提供简介。';
  executorCommand.textContent = getExecutorPreview(selectedExecutor);
  updateExecutorControls();
});
selectProjectButton.addEventListener('click', selectProject);
refreshProjectButton.addEventListener('click', async () => {
  await loadCurrentProject();
  const session = await loadTerminalSession();
  await loadExecutors();
  tryRestoreRunningSession(session);
});
refreshExecutorsButton.addEventListener('click', loadExecutors);
runExecutorButton.addEventListener('click', runExecutor);
openTerminalButton.addEventListener('click', () => {
  connectTerminal('connect');
});
reconnectTerminalButton.addEventListener('click', () => {
  connectTerminal('reconnect');
});

renderProject(null);
renderSession(null);
renderExecutors();
setTerminalConnectionState('未连接');

await loadHealth();
await loadCurrentProject();
await loadExecutors();
const initialSession = await loadTerminalSession();
tryRestoreRunningSession(initialSession);
