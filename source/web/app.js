const healthStatus = document.querySelector('#health-status');
const apiVersion = document.querySelector('#api-version');
const projectPath = document.querySelector('#project-path');
const projectName = document.querySelector('#project-name');
const statusLog = document.querySelector('#status-log');
const selectProjectButton = document.querySelector('#select-project');
const refreshProjectButton = document.querySelector('#refresh-project');

function appendLog(message, tone = '') {
  const timestamp = new Date().toLocaleTimeString();
  const line = `[${timestamp}] ${message}`;
  statusLog.textContent = `${line}\n${statusLog.textContent}`.trim();

  if (tone) {
    healthStatus.className = tone;
  }
}

function renderProject(project) {
  if (!project) {
    projectPath.textContent = '尚未选择工程目录';
    projectName.textContent = '点击“选择工程”后，服务会保存当前项目路径。';
    return;
  }

  projectPath.textContent = project.path;
  projectName.textContent = `项目名称：${project.name}`;
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
    appendLog(`工程目录已更新：${payload.project.path}`, 'success');
  } catch (error) {
    appendLog(`选择工程目录失败：${error.message}`, 'warn');
  } finally {
    selectProjectButton.disabled = false;
    selectProjectButton.textContent = '选择工程';
  }
}

selectProjectButton.addEventListener('click', selectProject);
refreshProjectButton.addEventListener('click', loadCurrentProject);

await loadHealth();
await loadCurrentProject();
