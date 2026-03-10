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
const toggleTaskFormButton = document.querySelector('#toggle-task-form');
const taskForm = document.querySelector('#task-form');
const taskTitleInput = document.querySelector('#task-title');
const taskDescriptionInput = document.querySelector('#task-description');
const taskExecutorSelect = document.querySelector('#task-executor-select');
const taskList = document.querySelector('#task-list');
const tasksSummary = document.querySelector('#tasks-summary');
const createTaskButton = document.querySelector('#create-task');
const structureFilter = document.querySelector('#structure-filter');
const structureList = document.querySelector('#structure-list');

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
let tasks = [];
const noteEditorState = new Map();
const dependencyEditorState = new Map();
let selectedExecutorId = null;
const defaultExecutorOutputName = 'project-summary';
let executorStatusLock = null;
let lastKnownTerminalSize = {
  cols: null,
  rows: null,
};
let structureFilterMode = 'all';
const structureRowState = new Map();
let structureSelectedTaskId = null;

const TASK_STATUS_LABELS = {
  idle: '未运行',
  running: '运行中',
  waiting: '等待处理',
  ended: '已结束',
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

function formatTaskStatus(status) {
  return TASK_STATUS_LABELS[status] ?? TASK_STATUS_LABELS.idle;
}

function formatTaskTime(value) {
  if (!value) {
    return '—';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '—';
  }

  return date.toLocaleString();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function truncateText(value, maxLength = 140) {
  const normalized = String(value ?? '').trim().replace(/\s+/g, ' ');

  if (!normalized) {
    return '';
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}…`;
}

function getTaskPrimaryNote(task) {
  if (Array.isArray(task?.attachments)) {
    const noteAttachment = task.attachments.find((attachment) => attachment.type === 'note');

    if (noteAttachment?.content) {
      return {
        content: noteAttachment.content,
        updatedAt: noteAttachment.updatedAt ?? null,
      };
    }
  }

  return task?.note ?? null;
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

    if (normalized.length >= 50) {
      break;
    }
  }

  return normalized;
}

function getTaskDependencyEditorState(task) {
  const existing = dependencyEditorState.get(task.id);

  if (existing) {
    return existing;
  }

  const state = {
    isEditing: false,
    selectedIds: normalizeDependencyIds(task.dependencyIds),
    isSaving: false,
  };

  dependencyEditorState.set(task.id, state);
  return state;
}

function syncTaskDependencyEditorState(task) {
  const state = getTaskDependencyEditorState(task);

  if (!state.isEditing) {
    state.selectedIds = normalizeDependencyIds(task.dependencyIds);
  }

  return state;
}

function formatDependencySummary(task) {
  const depIds = normalizeDependencyIds(task?.dependencyIds);

  if (depIds.length === 0) {
    return {
      text: '暂无依赖任务。',
      isEmpty: true,
    };
  }

  const titleById = new Map(tasks.map((item) => [item.id, item.title || item.id.slice(0, 8)]));
  const resolved = depIds
    .map((id) => titleById.get(id) ?? id.slice(0, 8))
    .slice(0, 4);
  const suffix = depIds.length > resolved.length ? `等 ${depIds.length} 项` : `共 ${depIds.length} 项`;

  return {
    text: `依赖：${resolved.join('，')}（${suffix}）`,
    isEmpty: false,
  };
}

function buildDependencyIndex(allTasks) {
  const byId = new Map();
  const dependentsCountById = new Map();
  const depIdsByOwnerId = new Map();
  const dependentIdsByTaskId = new Map();

  for (const task of allTasks) {
    byId.set(task.id, task);
  }

  for (const task of allTasks) {
    const depIds = normalizeDependencyIds(task.dependencyIds);
    depIdsByOwnerId.set(task.id, depIds);

    for (const depId of depIds) {
      dependentsCountById.set(depId, (dependentsCountById.get(depId) ?? 0) + 1);

      const list = dependentIdsByTaskId.get(depId) ?? [];
      list.push(task.id);
      dependentIdsByTaskId.set(depId, list);
    }
  }

  return {
    byId,
    depIdsByOwnerId,
    dependentsCountById,
    dependentIdsByTaskId,
  };
}

function getBlockingDependencyTitles(depIds, index) {
  const blocking = [];

  for (const depId of depIds) {
    const task = index.byId.get(depId);

    if (!task) {
      continue;
    }

    if (task.status === 'ended') {
      continue;
    }

    blocking.push(task.title || depId.slice(0, 8));

    if (blocking.length >= 6) {
      break;
    }
  }

  return blocking;
}

function getTaskDisplayName(task) {
  return task?.title ? task.title : (task?.id ? task.id.slice(0, 8) : '—');
}

function isStructureRowExpanded(taskId) {
  return structureRowState.get(taskId)?.expanded === true;
}

function setStructureRowExpanded(taskId, expanded) {
  const current = structureRowState.get(taskId) ?? {};
  structureRowState.set(taskId, { ...current, expanded: Boolean(expanded) });
}

function renderTaskIdChips(ids, titleById, { muted = false } = {}) {
  if (!ids || ids.length === 0) {
    return `<span class="task-link-chip is-muted">${muted ? '无' : '—'}</span>`;
  }

  return ids.map((id) => {
    const name = titleById.get(id) ?? id.slice(0, 8);
    return `<button type="button" class="task-link-chip" data-action="goto-task" data-task-id="${escapeHtml(id)}">${escapeHtml(name)}</button>`;
  }).join('');
}

function detectCycleTaskIds(depIndex) {
  const indexById = new Map();
  const lowById = new Map();
  const onStack = new Set();
  const stack = [];
  const inCycle = new Set();
  let nextIndex = 0;

  function strongConnect(taskId) {
    indexById.set(taskId, nextIndex);
    lowById.set(taskId, nextIndex);
    nextIndex += 1;

    stack.push(taskId);
    onStack.add(taskId);

    const deps = depIndex.depIdsByOwnerId.get(taskId) ?? [];

    for (const depId of deps) {
      if (!depIndex.byId.has(depId)) {
        continue;
      }

      if (!indexById.has(depId)) {
        strongConnect(depId);
        lowById.set(taskId, Math.min(lowById.get(taskId), lowById.get(depId)));
        continue;
      }

      if (onStack.has(depId)) {
        lowById.set(taskId, Math.min(lowById.get(taskId), indexById.get(depId)));
      }
    }

    if (lowById.get(taskId) !== indexById.get(taskId)) {
      return;
    }

    const scc = [];

    while (stack.length > 0) {
      const top = stack.pop();
      onStack.delete(top);
      scc.push(top);

      if (top === taskId) {
        break;
      }
    }

    if (scc.length > 1) {
      for (const id of scc) {
        inCycle.add(id);
      }
      return;
    }

    const only = scc[0];
    const onlyDeps = depIndex.depIdsByOwnerId.get(only) ?? [];

    if (onlyDeps.includes(only)) {
      inCycle.add(only);
    }
  }

  for (const taskId of depIndex.byId.keys()) {
    if (indexById.has(taskId)) {
      continue;
    }

    strongConnect(taskId);
  }

  return inCycle;
}

function renderStructureView(depIndex, { cycleTaskIds } = {}) {
  if (!structureList) {
    return;
  }

  if (tasks.length === 0) {
    structureList.innerHTML = '<div class="task-structure-empty">当前没有任务卡。</div>';
    return;
  }

  const titleById = new Map(tasks.map((task) => [task.id, getTaskDisplayName(task)]));
  const selectedTask = structureSelectedTaskId ? depIndex.byId.get(structureSelectedTaskId) : null;
  const selectedDepIds = selectedTask
    ? new Set(depIndex.depIdsByOwnerId.get(selectedTask.id) ?? [])
    : new Set();
  const selectedDependentIds = selectedTask
    ? new Set(depIndex.dependentIdsByTaskId.get(selectedTask.id) ?? [])
    : new Set();

  const rows = tasks.filter((task) => {
    const depIds = depIndex.depIdsByOwnerId.get(task.id) ?? [];
    const dependentIds = depIndex.dependentIdsByTaskId.get(task.id) ?? [];
    const blocking = getBlockingDependencyTitles(depIds, depIndex);

    if (structureFilterMode === 'blocked') {
      return blocking.length > 0;
    }

    if (structureFilterMode === 'roots') {
      return depIds.length === 0;
    }

    if (structureFilterMode === 'leaves') {
      return dependentIds.length === 0;
    }

    if (structureFilterMode === 'hasDeps') {
      return depIds.length > 0;
    }

    if (structureFilterMode === 'hasDependents') {
      return dependentIds.length > 0;
    }

    return true;
  });

  if (rows.length === 0) {
    structureList.innerHTML = '<div class="task-structure-empty">当前过滤条件下没有任务。</div>';
    return;
  }

  structureList.innerHTML = rows.map((task) => {
    const depIds = depIndex.depIdsByOwnerId.get(task.id) ?? [];
    const dependentIds = depIndex.dependentIdsByTaskId.get(task.id) ?? [];
    const blocking = getBlockingDependencyTitles(depIds, depIndex);
    const expanded = isStructureRowExpanded(task.id);
    const isSelected = Boolean(selectedTask && task.id === selectedTask.id);
    const isDep = Boolean(selectedTask && selectedDepIds.has(task.id));
    const isDependent = Boolean(selectedTask && selectedDependentIds.has(task.id));
    const hasCycle = Boolean(cycleTaskIds?.has(task.id));
    const rowClassName = [
      'task-structure-row',
      isSelected ? 'is-selected' : '',
      isDep ? 'is-dependency' : '',
      isDependent ? 'is-dependent' : '',
      hasCycle ? 'has-cycle' : '',
    ].filter(Boolean).join(' ');

    const depChips = depIds.length === 0
      ? '<span class="task-link-chip is-muted">无</span>'
      : renderTaskIdChips(depIds.slice(0, 6), titleById)
        + (depIds.length > 6 ? `<span class="task-link-chip is-muted">+${depIds.length - 6}</span>` : '');

    const dependentChips = dependentIds.length === 0
      ? '<span class="task-link-chip is-muted">无</span>'
      : renderTaskIdChips(dependentIds.slice(0, 6), titleById)
        + (dependentIds.length > 6 ? `<span class="task-link-chip is-muted">+${dependentIds.length - 6}</span>` : '');

    const blockedText = blocking.length > 0
      ? `未结束依赖：${blocking.join('，')}${depIds.length > blocking.length ? ' 等' : ''}`
      : '依赖均已结束或无依赖';

    return `
      <div class="${rowClassName}" data-structure-task-id="${escapeHtml(task.id)}">
        <div class="task-structure-main">
          <div class="task-structure-name">
            <strong>${escapeHtml(getTaskDisplayName(task))}</strong>
            <span class="status-dot ${escapeHtml(task.status)}"></span>
            <span class="task-structure-meta">${escapeHtml(formatTaskStatus(task.status))}</span>
            ${isSelected ? '<span class="task-focus-badge">焦点</span>' : ''}
            ${hasCycle ? '<span class="task-cycle-badge">环依赖</span>' : ''}
          </div>
          <div class="task-structure-meta">${escapeHtml(blockedText)}</div>
        </div>

        <div class="task-structure-col">
          <span class="label">依赖</span>
          <div class="task-structure-chips">${depChips}</div>
        </div>

        <div class="task-structure-col">
          <span class="label">被依赖</span>
          <div class="task-structure-chips">${dependentChips}</div>
        </div>

        <div class="task-structure-actions">
          <button class="secondary-button" data-action="goto-task" data-task-id="${escapeHtml(task.id)}">定位</button>
          <button class="secondary-button" data-action="edit-deps" data-task-id="${escapeHtml(task.id)}">编辑依赖</button>
          <button class="secondary-button" data-action="toggle-structure-details" data-task-id="${escapeHtml(task.id)}">${expanded ? '收起' : '展开'}</button>
        </div>

        ${expanded ? `
          <div class="task-structure-details">
            <div class="task-structure-details-block">
              <span class="label">依赖（全部）</span>
              <div class="task-structure-details-box">
                <div class="task-structure-chips">${renderTaskIdChips(depIds, titleById, { muted: true })}</div>
              </div>
            </div>
            <div class="task-structure-details-block">
              <span class="label">被依赖（全部）</span>
              <div class="task-structure-details-box">
                <div class="task-structure-chips">${renderTaskIdChips(dependentIds, titleById, { muted: true })}</div>
              </div>
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

function scrollToTaskCard(taskId) {
  // Avoid matching structure-view buttons (which also carry data-task-id).
  const selector = `.task-cluster[data-task-id="${CSS.escape(taskId)}"]`;
  const target = document.querySelector(selector);

  if (!target) {
    return false;
  }

  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return true;
}

function getTaskNoteEditorState(task) {
  const existing = noteEditorState.get(task.id);

  if (existing) {
    return existing;
  }

  const note = getTaskPrimaryNote(task);
  const state = {
    isEditing: false,
    draft: note?.content ?? '',
    isSaving: false,
  };

  noteEditorState.set(task.id, state);
  return state;
}

function syncTaskNoteEditorState(task) {
  const state = getTaskNoteEditorState(task);
  const note = getTaskPrimaryNote(task);

  if (!state.isEditing) {
    state.draft = note?.content ?? '';
  }

  return state;
}

function formatTaskNoteUpdatedAt(note) {
  return note?.updatedAt ? formatTaskTime(note.updatedAt) : '—';
}

function summarizeTaskNote(note) {
  return truncateText(note?.content ?? '', 120);
}

function summarizeTasks() {
  const counts = {
    total: tasks.length,
    idle: 0,
    running: 0,
    waiting: 0,
    ended: 0,
  };

  for (const task of tasks) {
    if (counts[task.status] != null) {
      counts[task.status] += 1;
    }
  }

  return counts;
}

function syncTaskExecutorOptions() {
  if (!taskExecutorSelect) {
    return;
  }

  taskExecutorSelect.innerHTML = '';

  if (executors.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '暂无可用执行器';
    taskExecutorSelect.append(option);
    taskExecutorSelect.disabled = true;
    return;
  }

  for (const executor of executors) {
    const option = document.createElement('option');
    option.value = executor.id;
    option.textContent = executor.name;
    taskExecutorSelect.append(option);
  }

  if (!executors.some((executor) => executor.id === taskExecutorSelect.value)) {
    taskExecutorSelect.value = executors[0].id;
  }

  taskExecutorSelect.disabled = !currentProject?.path;
}

function renderTasks() {
  if (!taskList || !tasksSummary) {
    return;
  }

  const depIndex = buildDependencyIndex(tasks);
  const cycleTaskIds = detectCycleTaskIds(depIndex);
  renderStructureView(depIndex, { cycleTaskIds });
  const summary = summarizeTasks();
  tasksSummary.innerHTML = [
    { label: '任务总数', value: summary.total },
    { label: '未运行', value: summary.idle },
    { label: '运行中', value: summary.running },
    { label: '等待处理', value: summary.waiting },
    { label: '已结束', value: summary.ended },
  ].map((item) => `
    <div class="summary-chip">
      <span class="label">${item.label}</span>
      <strong>${item.value}</strong>
    </div>
  `).join('');

  if (tasks.length === 0) {
    taskList.innerHTML = '<div class="task-empty">还没有任务卡。先创建一个最小 TaskCard，再从卡片直接启动执行。</div>';
    return;
  }

  taskList.innerHTML = tasks.map((task) => {
    const executorName = executors.find((executor) => executor.id === task.executorId)?.name ?? task.executorId ?? '未绑定';
    const sessionShortId = task.linkedSessionId ? task.linkedSessionId.slice(0, 8) : '—';
    const canRun = Boolean(currentProject?.path && task.executorId);
    const terminalBindingText = task.linkedSessionId
      ? `共享终端 · ${sessionShortId}`
      : '尚未绑定共享终端';
    const terminalHint = task.linkedSessionId
      ? '当前阶段所有任务共享一个活跃终端；运行新任务会把当前绑定切到这张卡。'
      : '点击运行后，会复用当前唯一活跃终端。';
    const noteEditor = syncTaskNoteEditorState(task);
    const note = getTaskPrimaryNote(task);
    const hasNote = Boolean(note?.content);
    const noteActionLabel = hasNote ? '编辑备注' : '添加备注';
    const noteSummary = hasNote
      ? summarizeTaskNote(note)
      : '添加这张任务卡的上下文、说明或补充记录';
    const noteUpdatedAt = hasNote ? formatTaskNoteUpdatedAt(note) : '暂无备注';
    const depsEditor = syncTaskDependencyEditorState(task);
    const depIds = depIndex.depIdsByOwnerId.get(task.id) ?? normalizeDependencyIds(task.dependencyIds);
    const depsSummary = formatDependencySummary({ dependencyIds: depIds });
    const depsActionLabel = depsEditor.isEditing ? '收起依赖' : '编辑依赖';
    const dependencyCount = depIds.length;
    const dependentsCount = depIndex.dependentsCountById.get(task.id) ?? 0;
    const blockingDeps = getBlockingDependencyTitles(depIds, depIndex);

    return `
      <article class="task-cluster" data-task-id="${escapeHtml(task.id)}">
        <section class="task-card task-primary-card">
          <div class="task-card-header">
            <div class="task-card-title">${escapeHtml(task.title)}</div>
            <p class="task-card-description">${escapeHtml(task.description || '暂无描述。')}</p>
          </div>

          <div class="task-card-meta">
            <div class="task-meta-grid">
              <div>
                <span class="label">执行器</span>
                <div>${escapeHtml(executorName)}</div>
              </div>
              <div>
                <span class="label">终端绑定</span>
                <div>${escapeHtml(terminalBindingText)}</div>
              </div>
              <div>
                <span class="label">依赖任务</span>
                <div>${escapeHtml(dependencyCount ? `${dependencyCount} 项` : '无')}</div>
              </div>
              <div>
                <span class="label">被依赖</span>
                <div>${escapeHtml(dependentsCount ? `${dependentsCount} 项` : '无')}</div>
              </div>
              <div>
                <span class="label">最近更新</span>
                <div>${escapeHtml(formatTaskTime(task.updatedAt))}</div>
              </div>
            </div>
            <span class="hint">${escapeHtml(terminalHint)}</span>
          </div>

          <div class="task-card-status">
            <div class="task-status-row">
              <span class="status-dot ${escapeHtml(task.status)}"></span>
              <strong>${escapeHtml(formatTaskStatus(task.status))}</strong>
            </div>
            <span class="hint">${escapeHtml(task.lastRunAt ? `最近运行：${formatTaskTime(task.lastRunAt)}` : '尚未运行。')}</span>
          </div>

          <div class="task-card-actions">
            <button class="primary-button" data-action="run-task" data-task-id="${escapeHtml(task.id)}" ${canRun ? '' : 'disabled'}>运行</button>
            <button class="secondary-button" data-action="focus-terminal" data-task-id="${escapeHtml(task.id)}">查看终端</button>
          </div>
        </section>

        <aside class="task-adjacent-lane">
          <section class="task-deps-card" data-deps-card data-task-id="${escapeHtml(task.id)}">
            <div class="task-deps-header">
              <div>
                <span class="label">结构层: 依赖</span>
                <div class="hint">先让任务关系可编辑，再考虑画布可视化。</div>
              </div>
              <button class="secondary-button" data-action="toggle-deps-editor" data-task-id="${escapeHtml(task.id)}">${escapeHtml(depsActionLabel)}</button>
            </div>

            ${depsEditor.isEditing ? `
              <div class="task-deps-editor">
                <div class="task-deps-list">
                  ${tasks.filter((item) => item.id !== task.id).length === 0 ? `
                    <div class="hint">当前没有其他任务可作为依赖。</div>
                  ` : tasks.filter((item) => item.id !== task.id).map((candidate) => {
                    const checked = depsEditor.selectedIds.includes(candidate.id);
                    const title = candidate.title || candidate.id.slice(0, 8);
                    return `
                      <label class="task-deps-item">
                        <input
                          type="checkbox"
                          data-action="dep-checkbox"
                          data-owner-task-id="${escapeHtml(task.id)}"
                          data-dep-task-id="${escapeHtml(candidate.id)}"
                          ${checked ? 'checked' : ''}
                          ${depsEditor.isSaving ? 'disabled' : ''}
                        />
                        <span>${escapeHtml(title)}</span>
                      </label>
                    `;
                  }).join('')}
                </div>

                <div class="task-deps-actions">
                  <button class="primary-button" data-action="save-deps" data-task-id="${escapeHtml(task.id)}" ${depsEditor.isSaving ? 'disabled' : ''}>保存依赖</button>
                  <button class="secondary-button" data-action="cancel-deps" data-task-id="${escapeHtml(task.id)}" ${depsEditor.isSaving ? 'disabled' : ''}>取消</button>
                </div>
              </div>
            ` : `
              <div class="task-deps-summary ${depsSummary.isEmpty ? 'is-empty' : ''}">
                ${escapeHtml(depsSummary.text)}
              </div>

              ${blockingDeps.length > 0 ? `
                <div class="task-deps-warning">
                  <strong>依赖未结束（仅提示，不阻止运行）</strong>
                  <div>${escapeHtml(blockingDeps.join('，'))}${dependencyCount > blockingDeps.length ? ' 等' : ''}</div>
                </div>
              ` : ''}
            `}
          </section>

          <section class="task-note-card task-attachment-card ${noteEditor.isEditing ? 'editing' : ''}" data-note-card data-attachment-type="note">
            <div class="task-note-header">
              <div>
                <span class="label">邻接备注</span>
                <div class="task-note-updated">${escapeHtml(noteUpdatedAt)}</div>
              </div>
              <button class="secondary-button" data-action="toggle-note-editor" data-task-id="${escapeHtml(task.id)}">${escapeHtml(noteActionLabel)}</button>
            </div>

            ${noteEditor.isEditing ? `
              <div class="task-note-editor">
                <textarea
                  class="task-textarea task-note-textarea"
                  data-note-input="${escapeHtml(task.id)}"
                  placeholder="添加这张任务卡的上下文、说明或补充记录"
                  ${noteEditor.isSaving ? 'disabled' : ''}
                >${escapeHtml(noteEditor.draft)}</textarea>
                <div class="task-note-actions">
                  <button class="primary-button" data-action="save-note" data-task-id="${escapeHtml(task.id)}" ${noteEditor.isSaving ? 'disabled' : ''}>保存</button>
                  <button class="secondary-button" data-action="cancel-note" data-task-id="${escapeHtml(task.id)}" ${noteEditor.isSaving ? 'disabled' : ''}>取消</button>
                </div>
              </div>
            ` : `
              <div class="task-note-summary ${hasNote ? '' : 'is-empty'}">
                ${escapeHtml(noteSummary || '暂无备注')}
              </div>
            `}
          </section>
        </aside>
      </article>
    `;
  }).join('');
}

function toggleTaskForm(forceOpen) {
  if (!taskForm) {
    return;
  }

  const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : taskForm.hidden;
  taskForm.hidden = !shouldOpen;

  if (toggleTaskFormButton) {
    toggleTaskFormButton.textContent = shouldOpen ? '收起表单' : '新建任务';
  }

  if (shouldOpen) {
    taskTitleInput?.focus();
  }
}

function focusTerminalPanel(task) {
  terminalPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  terminal?.focus();

  if (task?.title) {
    appendLog(`已定位到共享终端，可继续处理任务“${task.title}”。`);
  }
}

function getCurrentTerminalSize() {
  return {
    cols: terminal?.cols ?? lastKnownTerminalSize.cols ?? 120,
    rows: terminal?.rows ?? lastKnownTerminalSize.rows ?? 32,
  };
}

function getTaskRunParams(task) {
  if (task?.executorId === 'project-summary-doc') {
    return getExecutorParams();
  }

  return {};
}

function upsertTask(nextTask) {
  const index = tasks.findIndex((task) => task.id === nextTask.id);

  if (index === -1) {
    tasks = [nextTask, ...tasks];
  } else {
    tasks[index] = nextTask;
    tasks = [...tasks];
  }

  renderTasks();
}

async function loadTasks() {
  try {
    const response = await fetch('/api/tasks', { cache: 'no-store' });
    const payload = await response.json();
    tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
    renderTasks();
  } catch (error) {
    appendLog(`读取任务列表失败：${error.message}`, 'warn');
    tasks = [];
    renderTasks();
  }
}

async function refreshTasksSilently() {
  try {
    const response = await fetch('/api/tasks', { cache: 'no-store' });
    const payload = await response.json();
    tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
    renderTasks();
  } catch {
    // ignore silent refresh failures from terminal event sync
  }
}

async function createTaskCard() {
  const title = taskTitleInput?.value?.trim() ?? '';
  const description = taskDescriptionInput?.value?.trim() ?? '';
  const executorId = taskExecutorSelect?.value?.trim() ?? '';

  if (!title) {
    appendLog('请先输入任务标题。', 'warn');
    taskTitleInput?.focus();
    return;
  }

  if (!executorId) {
    appendLog('请先为任务选择执行器。', 'warn');
    taskExecutorSelect?.focus();
    return;
  }

  createTaskButton.disabled = true;

  try {
    const response = await fetch('/api/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title, description, executorId }),
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error ?? '创建任务失败');
    }

    upsertTask(payload.task);
    taskForm.reset();
    syncTaskExecutorOptions();
    toggleTaskForm(false);
    appendLog(`已创建任务卡：${payload.task.title}`, 'success');
  } catch (error) {
    appendLog(`创建任务失败：${error.message}`, 'warn');
  } finally {
    createTaskButton.disabled = false;
  }
}

function openTaskNoteEditor(taskId) {
  const task = tasks.find((item) => item.id === taskId);

  if (!task) {
    return;
  }

  const state = getTaskNoteEditorState(task);
  const note = getTaskPrimaryNote(task);
  state.isEditing = true;
  state.isSaving = false;
  state.draft = note?.content ?? '';
  renderTasks();

  window.requestAnimationFrame(() => {
    taskList?.querySelector(`[data-note-input="${taskId}"]`)?.focus();
  });
}

function cancelTaskNoteEditor(taskId) {
  const task = tasks.find((item) => item.id === taskId);

  if (!task) {
    return;
  }

  const state = getTaskNoteEditorState(task);
  const note = getTaskPrimaryNote(task);
  state.isEditing = false;
  state.isSaving = false;
  state.draft = note?.content ?? '';
  renderTasks();
}

async function saveTaskNote(taskId) {
  const task = tasks.find((item) => item.id === taskId);

  if (!task) {
    appendLog('未找到对应任务卡。', 'warn');
    return;
  }

  const state = getTaskNoteEditorState(task);
  state.isSaving = true;
  renderTasks();

  try {
    const response = await fetch('/api/tasks/note', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        taskId,
        content: state.draft,
      }),
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error ?? '保存备注失败');
    }

    state.isEditing = false;
    state.isSaving = false;
    state.draft = payload.task?.note?.content ?? '';
    upsertTask(payload.task);
    appendLog(`任务卡“${payload.task.title}”备注已保存。`, 'success');
  } catch (error) {
    state.isSaving = false;
    renderTasks();
    appendLog(`保存备注失败：${error.message}`, 'warn');
  }
}

function openTaskDependencyEditor(taskId) {
  const task = tasks.find((item) => item.id === taskId);

  if (!task) {
    return;
  }

  const state = getTaskDependencyEditorState(task);
  state.isEditing = true;
  state.isSaving = false;
  state.selectedIds = normalizeDependencyIds(task.dependencyIds);
  renderTasks();
}

function cancelTaskDependencyEditor(taskId) {
  const task = tasks.find((item) => item.id === taskId);

  if (!task) {
    return;
  }

  const state = getTaskDependencyEditorState(task);
  state.isEditing = false;
  state.isSaving = false;
  state.selectedIds = normalizeDependencyIds(task.dependencyIds);
  renderTasks();
}

function toggleTaskDependencySelection(ownerTaskId, dependencyId, checked) {
  const owner = tasks.find((item) => item.id === ownerTaskId);

  if (!owner) {
    return;
  }

  const state = getTaskDependencyEditorState(owner);
  const next = new Set(state.selectedIds);

  if (checked) {
    next.add(dependencyId);
  } else {
    next.delete(dependencyId);
  }

  state.selectedIds = Array.from(next);
}

async function saveTaskDependencies(taskId) {
  const task = tasks.find((item) => item.id === taskId);

  if (!task) {
    appendLog('未找到对应任务卡。', 'warn');
    return;
  }

  const state = getTaskDependencyEditorState(task);
  state.isSaving = true;
  renderTasks();

  try {
    const response = await fetch('/api/tasks/dependencies', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        taskId,
        dependencyIds: state.selectedIds,
      }),
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error ?? '保存依赖失败');
    }

    state.isEditing = false;
    state.isSaving = false;
    upsertTask(payload.task);
    appendLog(`任务卡“${payload.task.title}”依赖关系已保存。`, 'success');
  } catch (error) {
    state.isSaving = false;
    renderTasks();
    appendLog(`保存依赖失败：${error.message}`, 'warn');
  }
}

async function runTask(taskId) {
  const task = tasks.find((item) => item.id === taskId);

  if (!task) {
    appendLog('未找到对应任务卡。', 'warn');
    return;
  }

  if (!currentProject?.path) {
    appendLog('请先选择工程目录，再运行任务卡。', 'warn');
    return;
  }

  try {
    ensureTerminal();
  } catch (error) {
    appendLog(`初始化终端失败：${error.message}`, 'warn');
    return;
  }

  if (socket?.readyState !== WebSocket.OPEN) {
    connectTerminal('connect');
  }

  const button = taskList.querySelector(`[data-action="run-task"][data-task-id="${taskId}"]`);
  if (button) {
    button.disabled = true;
  }

  try {
    const response = await fetch('/api/tasks/run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        taskId,
        params: getTaskRunParams(task),
        ...getCurrentTerminalSize(),
      }),
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error ?? '任务运行失败');
    }

    if (payload.session) {
      renderSession(payload.session);
    }

    if (payload.task) {
      upsertTask(payload.task);
    }

    appendLog(`任务卡“${task.title}”已注入终端。`, 'success');
    focusTerminalPanel(task);
  } catch (error) {
    appendLog(`任务运行失败：${error.message}`, 'warn');
  } finally {
    if (button) {
      button.disabled = false;
    }
  }
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
    syncTaskExecutorOptions();
    if (createTaskButton) {
      createTaskButton.disabled = true;
    }
    renderTasks();
    updateExecutorControls();
    return;
  }

  projectPath.textContent = project.path;
  projectName.textContent = `项目名称：${project.name}`;
  openTerminalButton.disabled = false;
  reconnectTerminalButton.disabled = false;
  syncTaskExecutorOptions();
  if (createTaskButton) {
    createTaskButton.disabled = executors.length === 0;
  }
  renderTasks();
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
    syncTaskExecutorOptions();
    if (createTaskButton) {
      createTaskButton.disabled = true;
    }
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
  syncTaskExecutorOptions();
  if (createTaskButton) {
    createTaskButton.disabled = !currentProject?.path;
  }
  renderTasks();
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

  socket.addEventListener('message', async (event) => {
    const payload = JSON.parse(event.data);

    if (payload.type === 'session') {
      renderSession(payload.session);
      await refreshTasksSilently();

      if (payload.recentOutput) {
        terminal.write(payload.recentOutput);
      }

      return;
    }

    if (payload.type === 'output') {
      terminal.write(payload.data);
      await refreshTasksSilently();
      return;
    }

    if (payload.type === 'exit') {
      renderSession(payload.session ?? null);
      await refreshTasksSilently();
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
toggleTaskFormButton?.addEventListener('click', () => {
  toggleTaskForm();
});
taskForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  await createTaskCard();
});
taskList?.addEventListener('input', (event) => {
  const input = event.target.closest('textarea[data-note-input]');

  if (!input) {
    const checkbox = event.target.closest('input[type="checkbox"][data-action="dep-checkbox"]');

    if (!checkbox) {
      return;
    }

    const ownerTaskId = checkbox.dataset.ownerTaskId;
    const depTaskId = checkbox.dataset.depTaskId;

    if (!ownerTaskId || !depTaskId) {
      return;
    }

    toggleTaskDependencySelection(ownerTaskId, depTaskId, checkbox.checked);
    return;
  }

  const taskId = input.dataset.noteInput;
  const task = tasks.find((item) => item.id === taskId);

  if (!task) {
    return;
  }

  const state = getTaskNoteEditorState(task);
  state.draft = input.value;
});
taskList?.addEventListener('click', async (event) => {
  const actionButton = event.target.closest('button[data-action]');

  if (!actionButton) {
    return;
  }

  const taskId = actionButton.dataset.taskId;
  const action = actionButton.dataset.action;

  if (action === 'run-task') {
    await runTask(taskId);
    return;
  }

  if (action === 'focus-terminal') {
    const task = tasks.find((item) => item.id === taskId) ?? null;
    focusTerminalPanel(task);
    return;
  }

  if (action === 'toggle-note-editor') {
    openTaskNoteEditor(taskId);
    return;
  }

  if (action === 'cancel-note') {
    cancelTaskNoteEditor(taskId);
    return;
  }

  if (action === 'save-note') {
    await saveTaskNote(taskId);
    return;
  }

  if (action === 'toggle-deps-editor') {
    const task = tasks.find((item) => item.id === taskId);

    if (!task) {
      return;
    }

    const state = getTaskDependencyEditorState(task);

    if (state.isEditing) {
      cancelTaskDependencyEditor(taskId);
    } else {
      openTaskDependencyEditor(taskId);
    }

    return;
  }

  if (action === 'cancel-deps') {
    cancelTaskDependencyEditor(taskId);
    return;
  }

  if (action === 'save-deps') {
    await saveTaskDependencies(taskId);
  }
});

structureFilter?.addEventListener('change', () => {
  structureFilterMode = structureFilter.value || 'all';
  renderTasks();
});

structureList?.addEventListener('click', (event) => {
  const actionButton = event.target.closest('button[data-action]');

  if (!actionButton) {
    const row = event.target.closest('.task-structure-row');

    if (!row) {
      return;
    }

    const nextId = row.dataset.structureTaskId;

    if (!nextId) {
      return;
    }

    structureSelectedTaskId = structureSelectedTaskId === nextId ? null : nextId;
    renderTasks();
    return;
  }

  const taskId = actionButton.dataset.taskId;
  const action = actionButton.dataset.action;

  if (!taskId) {
    return;
  }

  if (action === 'goto-task') {
    // Keep selection in sync with navigation intent.
    structureSelectedTaskId = taskId;
    renderTasks();
    if (!scrollToTaskCard(taskId)) {
      appendLog('未找到对应任务卡区域。', 'warn');
    }
    return;
  }

  if (action === 'edit-deps') {
    openTaskDependencyEditor(taskId);
    scrollToTaskCard(taskId);
    return;
  }

  if (action === 'toggle-structure-details') {
    setStructureRowExpanded(taskId, !isStructureRowExpanded(taskId));
    renderTasks();
    return;
  }
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
renderTasks();
setTerminalConnectionState('未连接');

await loadHealth();
await loadCurrentProject();
await loadExecutors();
await loadTasks();
const initialSession = await loadTerminalSession();
tryRestoreRunningSession(initialSession);
