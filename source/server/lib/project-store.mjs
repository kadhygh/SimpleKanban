import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const dataDir = path.resolve(process.cwd(), 'source/server/data');
const stateFilePath = path.join(dataDir, 'project-state.json');
const TASK_STATUSES = new Set(['idle', 'running', 'waiting', 'lost', 'ended']);
const TASK_ATTACHMENT_TYPES = new Set(['note']);
const MEMORY_TEXT_LIMIT = 8000;
const MEMORY_ENABLED = process.env.SIMPLEKANBAN_ENABLE_MEMORY === '1';
const TASK_DEPENDENCY_LIMIT = 50;
let mutationQueue = Promise.resolve();

function now() {
  return new Date().toISOString();
}

function enqueueMutation(fn) {
  // Serialize read-modify-write to avoid losing updates under concurrent callers.
  mutationQueue = mutationQueue
    .catch(() => {})
    .then(fn);

  return mutationQueue;
}

function mapProject(projectPath) {
  if (!projectPath) {
    return null;
  }

  return {
    name: path.basename(projectPath),
    path: projectPath,
    updatedAt: now(),
  };
}

function createDefaultState() {
  return {
    project: null,
    tasks: [],
    ...(MEMORY_ENABLED ? { memory: createDefaultMemory() } : {}),
  };
}

function createDefaultMemory() {
  return {
    focusTaskId: null,
    now: '',
    next: '',
    updatedAt: now(),
    verifiedAt: null,
    verifiedNote: null,
  };
}

function normalizeMemoryText(value) {
  const text = String(value ?? '').trim();

  if (!text) {
    return '';
  }

  if (text.length <= MEMORY_TEXT_LIMIT) {
    return text;
  }

  return text.slice(0, MEMORY_TEXT_LIMIT);
}

function normalizeMemory(input) {
  if (!input || typeof input !== 'object') {
    return createDefaultMemory();
  }

  return {
    focusTaskId: input.focusTaskId ? String(input.focusTaskId) : null,
    now: normalizeMemoryText(input.now),
    next: normalizeMemoryText(input.next),
    updatedAt: input.updatedAt ? String(input.updatedAt) : now(),
    verifiedAt: input.verifiedAt ? String(input.verifiedAt) : null,
    verifiedNote: input.verifiedNote ? normalizeMemoryText(input.verifiedNote) : null,
  };
}

function normalizeTaskStatus(status) {
  return TASK_STATUSES.has(status) ? status : 'idle';
}

function normalizeTaskDependencyIds(value, { selfId } = {}) {
  const raw = Array.isArray(value) ? value : [];
  const seen = new Set();
  const normalized = [];

  for (const item of raw) {
    const id = String(item ?? '').trim();

    if (!id) {
      continue;
    }

    if (selfId && id === selfId) {
      continue;
    }

    if (seen.has(id)) {
      continue;
    }

    seen.add(id);
    normalized.push(id);

    if (normalized.length >= TASK_DEPENDENCY_LIMIT) {
      break;
    }
  }

  return normalized;
}

function normalizeTaskNote(note, fallbackUpdatedAt = now()) {
  if (note == null) {
    return null;
  }

  const content = typeof note === 'string'
    ? note.trim()
    : String(note.content ?? '').trim();

  if (!content) {
    return null;
  }

  return {
    content,
    updatedAt: typeof note === 'object' && note.updatedAt ? String(note.updatedAt) : fallbackUpdatedAt,
  };
}

function normalizeTaskAttachment(attachment, fallbackTimestamps = {}) {
  if (!attachment || typeof attachment !== 'object') {
    return null;
  }

  const type = TASK_ATTACHMENT_TYPES.has(attachment.type) ? attachment.type : null;

  if (!type) {
    return null;
  }

  if (type === 'note') {
    const normalizedNote = normalizeTaskNote(attachment, fallbackTimestamps.updatedAt ?? now());

    if (!normalizedNote) {
      return null;
    }

    return {
      id: attachment.id ? String(attachment.id) : crypto.randomUUID(),
      type: 'note',
      relation: attachment.relation ? String(attachment.relation) : 'adjacent',
      order: Number.isFinite(attachment.order) ? Number(attachment.order) : 0,
      content: normalizedNote.content,
      createdAt: attachment.createdAt ? String(attachment.createdAt) : (fallbackTimestamps.createdAt ?? fallbackTimestamps.updatedAt ?? now()),
      updatedAt: attachment.updatedAt ? String(attachment.updatedAt) : (fallbackTimestamps.updatedAt ?? now()),
    };
  }

  return null;
}

function normalizeTaskAttachments(task, fallbackTimestamps = {}) {
  const hasExplicitAttachments = Array.isArray(task?.attachments);
  const attachments = hasExplicitAttachments
    ? task.attachments
        .map((attachment) => normalizeTaskAttachment(attachment, fallbackTimestamps))
        .filter(Boolean)
    : [];

  const primaryNote = attachments.find((attachment) => attachment.type === 'note') ?? null;

  if (primaryNote) {
    return [
      primaryNote,
      ...attachments.filter((attachment) => attachment.id !== primaryNote.id),
    ];
  }

  if (hasExplicitAttachments) {
    return attachments;
  }

  const legacyNote = normalizeTaskNote(task?.note, fallbackTimestamps.updatedAt ?? now());

  if (!legacyNote) {
    return [];
  }

  return [{
    id: crypto.randomUUID(),
    type: 'note',
    relation: 'adjacent',
    order: 0,
    content: legacyNote.content,
    createdAt: fallbackTimestamps.createdAt ?? legacyNote.updatedAt,
    updatedAt: legacyNote.updatedAt,
  }];
}

function getPrimaryTaskNoteAttachment(task) {
  return Array.isArray(task?.attachments)
    ? task.attachments.find((attachment) => attachment.type === 'note') ?? null
    : null;
}

function mapTask(task) {
  if (!task?.id) {
    return null;
  }

  const createdAt = task.createdAt ?? now();
  const updatedAt = task.updatedAt ?? now();
  const attachments = normalizeTaskAttachments(task, {
    createdAt,
    updatedAt,
  });
  const primaryNoteAttachment = getPrimaryTaskNoteAttachment({ attachments });
  const dependencyIds = normalizeTaskDependencyIds(task.dependencyIds ?? task.dependsOnIds, { selfId: task.id });

  return {
    id: task.id,
    title: String(task.title ?? '').trim(),
    description: String(task.description ?? '').trim(),
    executorId: String(task.executorId ?? '').trim(),
    status: normalizeTaskStatus(task.status),
    dependencyIds,
    linkedSessionId: task.linkedSessionId ? String(task.linkedSessionId) : null,
    lastRunAt: task.lastRunAt ?? null,
    lastStatusAt: task.lastStatusAt ?? null,
    lastTerminalActivityAt: task.lastTerminalActivityAt ?? null,
    lastTerminalOutput: task.lastTerminalOutput ? String(task.lastTerminalOutput) : null,
    attachments,
    note: primaryNoteAttachment
      ? {
          content: primaryNoteAttachment.content,
          updatedAt: primaryNoteAttachment.updatedAt,
        }
      : null,
    createdAt,
    updatedAt,
  };
}

async function readStateUnsafe() {
  await ensureStore();

  try {
    const raw = await fs.readFile(stateFilePath, 'utf8');

    if (!raw.trim()) {
      return createDefaultState();
    }

    const parsed = JSON.parse(raw);

    return {
      project: parsed?.project?.path
        ? {
            name: parsed.project.name ?? path.basename(parsed.project.path),
            path: parsed.project.path,
            updatedAt: parsed.project.updatedAt ?? null,
          }
        : null,
      tasks: Array.isArray(parsed?.tasks)
        ? parsed.tasks.map(mapTask).filter(Boolean)
        : [],
      ...(MEMORY_ENABLED ? { memory: normalizeMemory(parsed?.memory) } : {}),
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return createDefaultState();
    }

    if (error instanceof SyntaxError) {
      return createDefaultState();
    }

    throw error;
  }
}

async function readState() {
  // Wait for any queued mutations to flush before serving read-only queries.
  await mutationQueue;
  return readStateUnsafe();
}

async function writeState(state) {
  await ensureStore();
  const payload = JSON.stringify({
    ...(state ?? {}),
    ...(MEMORY_ENABLED ? { memory: normalizeMemory(state?.memory) } : {}),
    tasks: Array.isArray(state?.tasks)
      ? state.tasks.map((task) => {
          const mappedTask = mapTask(task);

          if (!mappedTask) {
            return null;
          }

          const { note, ...persistedTask } = mappedTask;
          return persistedTask;
        }).filter(Boolean)
      : [],
  }, null, 2);

  await fs.writeFile(stateFilePath, payload, 'utf8');
}

function buildTaskPatch(currentTask, patch) {
  const nextTask = mapTask({
    ...currentTask,
    ...patch,
    id: currentTask.id,
    createdAt: currentTask.createdAt,
    updatedAt: now(),
    status: patch?.status ? normalizeTaskStatus(patch.status) : currentTask.status,
    dependencyIds: patch?.dependencyIds ?? currentTask.dependencyIds ?? [],
  });

  return nextTask;
}

function areTasksEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function ensureStore() {
  await fs.mkdir(dataDir, { recursive: true });
}

export async function readCurrentProject() {
  const state = await readState();
  return state.project;
}

export async function saveCurrentProject(projectPath) {
  return enqueueMutation(async () => {
    const state = await readStateUnsafe();
    const project = mapProject(projectPath);
    await writeState({
      ...state,
      project,
    });

    return project;
  });
}

export async function listTasks() {
  const state = await readState();
  return state.tasks;
}

export async function markInterruptedTasksLost(activeSessionId = null) {
  return enqueueMutation(async () => {
    const state = await readStateUnsafe();
    const timestamp = now();

    if (!Array.isArray(state.tasks) || state.tasks.length === 0) {
      return { changed: false, affectedCount: 0 };
    }

    let affectedCount = 0;

    const nextTasks = state.tasks.map((task) => {
      if (!task) {
        return task;
      }

      if (task.status !== 'running' && task.status !== 'waiting') {
        return task;
      }

      // On boot, any previous "running/waiting" task cannot be trusted because PTY sessions don't survive restarts.
      // If an active session id is provided, keep tasks bound to it.
      if (activeSessionId && task.linkedSessionId === activeSessionId) {
        return task;
      }

      affectedCount += 1;

      return {
        ...task,
        status: 'lost',
        linkedSessionId: null,
        lastStatusAt: timestamp,
        updatedAt: timestamp,
      };
    });

    if (affectedCount === 0) {
      return { changed: false, affectedCount: 0 };
    }

    await writeState({
      ...state,
      tasks: nextTasks,
    });

    return { changed: true, affectedCount };
  });
}

export async function readMemory() {
  if (!MEMORY_ENABLED) {
    return null;
  }

  const state = await readState();
  return state.memory ?? null;
}

export async function updateMemory(patch) {
  if (!MEMORY_ENABLED) {
    throw new Error('Memory feature is sealed. Set SIMPLEKANBAN_ENABLE_MEMORY=1 to enable.');
  }

  return enqueueMutation(async () => {
    const state = await readStateUnsafe();
    const current = normalizeMemory(state.memory);
    const timestamp = now();

    const shouldMarkVerified = Boolean(patch?.markVerified);
    const verifiedNote = patch?.verifiedNote != null ? normalizeMemoryText(patch.verifiedNote) : current.verifiedNote;

    const nextMemory = normalizeMemory({
      ...current,
      focusTaskId: patch?.focusTaskId === null
        ? null
        : (patch?.focusTaskId ? String(patch.focusTaskId) : current.focusTaskId),
      now: patch?.now != null ? normalizeMemoryText(patch.now) : current.now,
      next: patch?.next != null ? normalizeMemoryText(patch.next) : current.next,
      updatedAt: timestamp,
      verifiedAt: shouldMarkVerified ? timestamp : current.verifiedAt,
      verifiedNote: shouldMarkVerified ? verifiedNote : verifiedNote,
    });

    await writeState({
      ...state,
      memory: nextMemory,
    });

    return nextMemory;
  });
}

export async function createTask(input) {
  return enqueueMutation(async () => {
    const title = String(input?.title ?? '').trim();
    const description = String(input?.description ?? '').trim();
    const executorId = String(input?.executorId ?? '').trim();

    if (!title) {
      throw new Error('Task title is required.');
    }

    if (!executorId) {
      throw new Error('Task executorId is required.');
    }

    const state = await readStateUnsafe();
    const timestamp = now();
    const task = mapTask({
      id: crypto.randomUUID(),
      title,
      description,
      executorId,
      status: 'idle',
      dependencyIds: [],
      linkedSessionId: null,
      lastRunAt: null,
      lastStatusAt: timestamp,
      lastTerminalActivityAt: null,
      lastTerminalOutput: null,
      attachments: [],
      note: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    state.tasks = [...state.tasks, task];
    await writeState(state);
    return task;
  });
}

export async function getTask(taskId) {
  const tasks = await listTasks();
  return tasks.find((task) => task.id === taskId) ?? null;
}

export async function updateTask(taskId, patch) {
  return enqueueMutation(async () => {
    const state = await readStateUnsafe();
    const index = state.tasks.findIndex((task) => task.id === taskId);

    if (index === -1) {
      return null;
    }

    const currentTask = state.tasks[index];
    const nextTask = buildTaskPatch(currentTask, patch);

    if (areTasksEqual(currentTask, nextTask)) {
      return currentTask;
    }

    state.tasks[index] = nextTask;
    await writeState(state);
    return nextTask;
  });
}
