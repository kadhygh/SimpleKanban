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
const executorOutputName = document.querySelector('#executor-output-name');
const executorStatus = document.querySelector('#executor-status');
const executorStatusDetail = document.querySelector('#executor-status-detail');
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
const defaultExecutorOutputName = 'project-summary';
let executorStatusLock = null;
let lastKnownTerminalSize = {
  cols: null,
  rows: null,
};

function normalizeExecutorOutputName(value) {
  const normalized = String(value ?? '')
    .trim()
    .replace(/\.md$/i, '')
    .replace(/[^a-zA-Z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return normalized || defaultExecutorOutputName;
}

function getExecutorParams() {
  return {
    outputFileName: normalizeExecutorOutputName(executorOutputName?.value),
  };
}

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

function setExecutorStatus(text, tone = '', detail = '') {
  executorStatus.textContent = text;
  executorStatus.className = `status-badge ${tone}`.trim();

  if (executorStatusDetail) {
    executorStatusDetail.textContent = detail || ' ';
  }
}

function lockExecutorStatus(text, tone = '', detail = '') {
  executorStatusLock = { text, tone, detail };
  setExecutorStatus(text, tone, detail);
}

function clearExecutorStatusLock() {
  executorStatusLock = null;
}

function getSelectedExecutor() {
  return executors.find((executor) => executor.id === selectedExecutorId) ?? null;
}

function getExecutorPreview(executor) {
  if (!executor) {
    return '等待加载命令预览。';
  }

  const basePreview = executor.commandPreview ?? executor.previewCommand ?? executor.command ?? '当前执行器未提供命令预览。';

  if (executor.id !== 'project-summary-doc') {
    return basePreview;
  }

  const { outputFileName } = getExecutorParams();
  return basePreview.replace(/project-summary\.md/gi, `${outputFileName}.md`);
}

function updateExecutorControls() {
  const hasProject = Boolean(currentProject?.path);
  const hasExecutors = executors.length > 0;
  const hasRunningTerminal = currentSession?.status === 'running';

  executorSelect.disabled = !hasExecutors;
  executorOutputName.disabled = !hasProject || !hasExecutors;
  refreshExecutorsButton.disabled = !hasProject;
  runExecutorButton.disabled = !hasProject || !hasExecutors;

  if (executorStatusLock) {
    setExecutorStatus(executorStatusLock.text, executorStatusLock.tone, executorStatusLock.detail);
    return;
  }

  if (!hasProject) {
    setExecutorStatus('请先选择工程', 'warn', '选择工程目录后，才能加载执行器并注入命令。');
    return;
  }

  if (!hasExecutors) {
    setExecutorStatus('未加载执行器', 'warn', '当前项目下还没有可用执行器，或执行器列表尚未加载完成。');
    return;
  }

  if (!hasRunningTerminal) {
    setExecutorStatus('请先启动终端', 'warn', '执行器命令会被注入当前网页终端，因此需要先启动终端会话。');
    return;
  }

  setExecutorStatus('可注入', 'success', '当前执行器与参数已就绪，可以直接把命令注入终端执行。');
}

function renderProject(project) {
  clearExecutorStatusLock();
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
  clearExecutorStatusLock();
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
  clearExecutorStatusLock();
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
  clearExecutorStatusLock();

  try {
    const response = await fetch('/api/executors', { cache: 'no-store' });
    const payload = await response.json();
    executors = payload.executors ?? [];
    renderExecutors();
    appendLog(`已加载执行器：${executors.length} 个。`);
    setExecutorStatus('已加载', 'success', '执行器列表已刷新；如果终端已启动，现在可以继续注入命令。');
  } catch (error) {
    executors = [];
    renderExecutors();
    appendLog(`读取执行器列表失败：${error.message}`, 'warn');
    setExecutorStatus('加载失败', 'warn', '执行器列表读取失败，请稍后重试。');
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
    setExecutorStatus('请先启动终端', 'warn', '当前没有运行中的终端会话，无法把命令注入进去。');
    return;
  }

  runExecutorButton.disabled = true;
  lockExecutorStatus('注入中', 'warn', '命令正在发送到当前网页终端，请等待终端输出结果。');

  try {
    const response = await fetch('/api/executors/run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        executorId: selectedExecutor.id,
        params: getExecutorParams(),
      }),
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error ?? '执行器注入失败');
    }

    executorCommand.textContent = payload.command ?? getExecutorPreview(selectedExecutor);
    appendLog(`已将执行器“${selectedExecutor.name}”注入终端。`, 'success');
    const outputPath = payload.params?.summaryRelativePath ?? `docs/${getExecutorParams().outputFileName}.md`;
    lockExecutorStatus('已注入', 'success', `命令已写入终端，预期会生成 ${outputPath}。`);
    terminal?.focus();
  } catch (error) {
    appendLog(`执行器注入失败：${error.message}`, 'warn');
    lockExecutorStatus('注入失败', 'warn', error.message || '命令注入失败，请查看状态输出与终端信息。');
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
  clearExecutorStatusLock();
  selectedExecutorId = executorSelect.value;
  const selectedExecutor = getSelectedExecutor();
  executorDescription.textContent = selectedExecutor?.description ?? '当前执行器未提供简介。';
  executorCommand.textContent = getExecutorPreview(selectedExecutor);
  updateExecutorControls();
});
executorOutputName.addEventListener('input', () => {
  clearExecutorStatusLock();
  const normalized = normalizeExecutorOutputName(executorOutputName.value);
  const selectedExecutor = getSelectedExecutor();
  executorCommand.textContent = getExecutorPreview(selectedExecutor);

  if (executorOutputName.value.trim() !== normalized) {
    setExecutorStatus('参数已规范化', 'warn', `输入已按安全规则处理，最终会生成 docs/${normalized}.md。`);
    return;
  }

  setExecutorStatus('参数已更新', 'success', `当前预期输出文件为 docs/${normalized}.md。`);
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
