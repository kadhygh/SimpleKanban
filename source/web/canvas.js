const refreshButton = document.querySelector('#refresh-canvas');
const summaryProject = document.querySelector('#summary-project');
const summaryTotal = document.querySelector('#summary-total');
const summaryActive = document.querySelector('#summary-active');
const summarySelection = document.querySelector('#summary-selection');
const canvasEmpty = document.querySelector('#canvas-empty');
const canvasScroll = document.querySelector('#canvas-scroll');
const canvasBoard = document.querySelector('#canvas-board');
const canvasLinks = document.querySelector('#canvas-links');
const canvasDetail = document.querySelector('#canvas-detail');

const STATUS_LABELS = {
  idle: '未运行',
  running: '运行中',
  waiting: '等待处理',
  lost: '会话丢失',
  ended: '已结束',
};

const NODE_WIDTH = 260;
const NODE_HEIGHT = 136;
const COLUMN_GAP = 110;
const ROW_GAP = 42;
const BOARD_PADDING_X = 64;
const BOARD_PADDING_Y = 48;

let currentProject = null;
let tasks = [];
let selectedTaskId = null;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function truncateText(value, maxLength = 88) {
  const normalized = String(value ?? '').trim().replace(/\s+/g, ' ');

  if (!normalized) {
    return '暂无描述。';
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}…`;
}

function normalizeDependencyIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set();
  const normalized = [];

  for (const item of value) {
    const id = String(item ?? '').trim();

    if (!id || seen.has(id)) {
      continue;
    }

    seen.add(id);
    normalized.push(id);
  }

  return normalized;
}

function formatStatus(status) {
  return STATUS_LABELS[status] ?? STATUS_LABELS.idle;
}

function formatTime(value) {
  if (!value) {
    return '—';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }

  return date.toLocaleString();
}

function summarizeTasks() {
  const counts = {
    total: tasks.length,
    running: 0,
    waiting: 0,
  };

  for (const task of tasks) {
    if (task.status === 'running') {
      counts.running += 1;
    }

    if (task.status === 'waiting') {
      counts.waiting += 1;
    }
  }

  return counts;
}

function getTaskPrimaryNote(task) {
  if (!Array.isArray(task?.attachments)) {
    return '';
  }

  const noteAttachment = task.attachments.find((attachment) => attachment.type === 'note');
  return String(noteAttachment?.content ?? '').trim();
}

function buildDependencyMaps(allTasks) {
  const byId = new Map();
  const depIdsById = new Map();
  const dependentsById = new Map();

  for (const task of allTasks) {
    byId.set(task.id, task);
  }

  for (const task of allTasks) {
    const depIds = normalizeDependencyIds(task.dependencyIds).filter((id) => byId.has(id) && id !== task.id);
    depIdsById.set(task.id, depIds);

    for (const depId of depIds) {
      if (!dependentsById.has(depId)) {
        dependentsById.set(depId, []);
      }

      dependentsById.get(depId).push(task.id);
    }
  }

  return {
    byId,
    depIdsById,
    dependentsById,
  };
}

function buildLayout(allTasks) {
  const maps = buildDependencyMaps(allTasks);
  const levelCache = new Map();
  const visiting = new Set();

  function resolveLevel(taskId) {
    if (levelCache.has(taskId)) {
      return levelCache.get(taskId);
    }

    if (visiting.has(taskId)) {
      return 0;
    }

    visiting.add(taskId);
    const depIds = maps.depIdsById.get(taskId) ?? [];
    const level = depIds.length === 0
      ? 0
      : Math.max(...depIds.map((depId) => resolveLevel(depId))) + 1;
    visiting.delete(taskId);
    levelCache.set(taskId, level);
    return level;
  }

  const columns = new Map();

  for (const task of allTasks) {
    const level = resolveLevel(task.id);
    if (!columns.has(level)) {
      columns.set(level, []);
    }

    columns.get(level).push(task);
  }

  const orderedLevels = [...columns.keys()].sort((left, right) => left - right);
  const positions = new Map();
  let maxRows = 0;

  for (const level of orderedLevels) {
    const columnTasks = columns.get(level).slice().sort((left, right) => left.title.localeCompare(right.title, 'zh-CN'));
    maxRows = Math.max(maxRows, columnTasks.length);

    columnTasks.forEach((task, index) => {
      positions.set(task.id, {
        x: BOARD_PADDING_X + level * (NODE_WIDTH + COLUMN_GAP),
        y: BOARD_PADDING_Y + index * (NODE_HEIGHT + ROW_GAP),
      });
    });
  }

  const boardWidth = Math.max(
    960,
    BOARD_PADDING_X * 2 + orderedLevels.length * NODE_WIDTH + Math.max(0, orderedLevels.length - 1) * COLUMN_GAP,
  );
  const boardHeight = Math.max(
    680,
    BOARD_PADDING_Y * 2 + maxRows * NODE_HEIGHT + Math.max(0, maxRows - 1) * ROW_GAP,
  );

  return {
    ...maps,
    positions,
    boardWidth,
    boardHeight,
  };
}

function renderSummary() {
  const counts = summarizeTasks();
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;

  summaryProject.textContent = currentProject?.name || '未选择工程';
  summaryTotal.textContent = String(counts.total);
  summaryActive.textContent = `${counts.running} 运行中 / ${counts.waiting} 等待`;
  summarySelection.textContent = selectedTask?.title || '未选择节点';
}

function renderDetail(layout) {
  const task = tasks.find((item) => item.id === selectedTaskId) ?? null;

  if (!task) {
    canvasDetail.innerHTML = '<div class="detail-placeholder">点击画布中的节点后，这里会显示任务说明、依赖、备注和最近状态。</div>';
    return;
  }

  const depIds = layout.depIdsById.get(task.id) ?? [];
  const dependentIds = layout.dependentsById.get(task.id) ?? [];
  const note = getTaskPrimaryNote(task);

  const dependencyChips = depIds.length > 0
    ? depIds.map((id) => `<span class="chip">${escapeHtml(layout.byId.get(id)?.title ?? id.slice(0, 8))}</span>`).join('')
    : '<span class="chip">无</span>';
  const dependentChips = dependentIds.length > 0
    ? dependentIds.map((id) => `<span class="chip">${escapeHtml(layout.byId.get(id)?.title ?? id.slice(0, 8))}</span>`).join('')
    : '<span class="chip">无</span>';

  canvasDetail.innerHTML = `
    <section class="detail-card">
      <h3 class="detail-title">${escapeHtml(task.title)}</h3>
      <p class="detail-desc">${escapeHtml(task.description || '暂无描述。')}</p>
    </section>
    <section class="detail-card">
      <div class="detail-grid">
        <div>
          <span class="label">状态</span>
          <strong>${escapeHtml(formatStatus(task.status))}</strong>
        </div>
        <div>
          <span class="label">执行器</span>
          <strong>${escapeHtml(task.executorId || '—')}</strong>
        </div>
        <div>
          <span class="label">最近运行</span>
          <strong>${escapeHtml(formatTime(task.lastRunAt))}</strong>
        </div>
        <div>
          <span class="label">最近更新</span>
          <strong>${escapeHtml(formatTime(task.updatedAt))}</strong>
        </div>
      </div>
    </section>
    <section class="detail-card">
      <span class="label">依赖任务</span>
      <div class="chip-list">${dependencyChips}</div>
    </section>
    <section class="detail-card">
      <span class="label">被依赖任务</span>
      <div class="chip-list">${dependentChips}</div>
    </section>
    <section class="detail-card">
      <span class="label">备注</span>
      <p class="detail-desc">${escapeHtml(note || '暂无备注。')}</p>
    </section>
    <section class="detail-card">
      <div class="detail-actions">
        <a class="ghost-link" href="/index.html#tasks-panel">回到工作台任务区</a>
      </div>
    </section>
  `;
}

function renderLinks(layout) {
  const segments = [];

  for (const task of tasks) {
    const targetPosition = layout.positions.get(task.id);
    const depIds = layout.depIdsById.get(task.id) ?? [];

    if (!targetPosition) {
      continue;
    }

    for (const depId of depIds) {
      const sourcePosition = layout.positions.get(depId);

      if (!sourcePosition) {
        continue;
      }

      const startX = sourcePosition.x + NODE_WIDTH;
      const startY = sourcePosition.y + NODE_HEIGHT / 2;
      const endX = targetPosition.x;
      const endY = targetPosition.y + NODE_HEIGHT / 2;
      const controlOffset = Math.max(40, Math.abs(endX - startX) * 0.4);

      segments.push(`
        <path
          class="canvas-link"
          d="M ${startX} ${startY} C ${startX + controlOffset} ${startY}, ${endX - controlOffset} ${endY}, ${endX} ${endY}"
        />
      `);
    }
  }

  canvasLinks.setAttribute('viewBox', `0 0 ${layout.boardWidth} ${layout.boardHeight}`);
  canvasLinks.setAttribute('width', String(layout.boardWidth));
  canvasLinks.setAttribute('height', String(layout.boardHeight));
  canvasLinks.innerHTML = segments.join('');
}

function renderNodes(layout) {
  const markup = tasks.map((task) => {
    const position = layout.positions.get(task.id);
    const depCount = (layout.depIdsById.get(task.id) ?? []).length;
    const dependentCount = (layout.dependentsById.get(task.id) ?? []).length;

    return `
      <button
        type="button"
        class="canvas-node ${task.id === selectedTaskId ? 'is-selected' : ''}"
        data-task-id="${escapeHtml(task.id)}"
        style="left:${position.x}px;top:${position.y}px;"
      >
        <div class="canvas-node-header">
          <strong class="canvas-node-title">${escapeHtml(task.title)}</strong>
          <span class="canvas-status ${escapeHtml(task.status)}">${escapeHtml(formatStatus(task.status))}</span>
        </div>
        <p class="canvas-node-desc">${escapeHtml(truncateText(task.description))}</p>
        <div class="canvas-node-meta">
          <div>
            <span class="label">依赖</span>
            <strong>${depCount}</strong>
          </div>
          <div>
            <span class="label">被依赖</span>
            <strong>${dependentCount}</strong>
          </div>
        </div>
      </button>
    `;
  }).join('');

  canvasBoard.style.width = `${layout.boardWidth}px`;
  canvasBoard.style.height = `${layout.boardHeight}px`;
  canvasLinks.style.width = `${layout.boardWidth}px`;
  canvasLinks.style.height = `${layout.boardHeight}px`;
  canvasBoard.innerHTML = markup;

  for (const button of canvasBoard.querySelectorAll('[data-task-id]')) {
    button.addEventListener('click', () => {
      selectedTaskId = button.dataset.taskId;
      renderCanvas();
    });
  }
}

function renderCanvas() {
  renderSummary();

  if (tasks.length === 0) {
    canvasEmpty.hidden = false;
    canvasScroll.hidden = true;
    canvasDetail.innerHTML = '<div class="detail-placeholder">当前没有任务可投影。先回工作台创建一些任务，再来观察 canvas 结构。</div>';
    return;
  }

  canvasEmpty.hidden = true;
  canvasScroll.hidden = false;

  if (!tasks.some((task) => task.id === selectedTaskId)) {
    selectedTaskId = tasks[0].id;
  }

  const layout = buildLayout(tasks);
  renderNodes(layout);
  renderLinks(layout);
  renderSummary();
  renderDetail(layout);
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }

  return payload;
}

async function loadData() {
  refreshButton.disabled = true;

  try {
    const [projectPayload, tasksPayload] = await Promise.all([
      fetchJson('/api/project/current'),
      fetchJson('/api/tasks'),
    ]);

    currentProject = projectPayload.project ?? null;
    tasks = Array.isArray(tasksPayload.tasks) ? tasksPayload.tasks : [];
    renderCanvas();
  } catch (error) {
    canvasEmpty.hidden = false;
    canvasScroll.hidden = true;
    canvasEmpty.textContent = error.message || '加载 canvas 数据失败。';
    canvasDetail.innerHTML = '<div class="detail-placeholder">请先确认服务可用，然后再刷新一次。</div>';
    renderSummary();
  } finally {
    refreshButton.disabled = false;
  }
}

refreshButton?.addEventListener('click', () => {
  loadData().catch((error) => {
    console.error(error);
  });
});

loadData().catch((error) => {
  console.error(error);
});
