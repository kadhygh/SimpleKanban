import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const dataDir = path.resolve(process.cwd(), 'source/server/data');
const stateFilePath = path.join(dataDir, 'project-state.json');

function now() {
  return new Date().toISOString();
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
  };
}

function normalizeTaskStatus(status) {
  const allowed = new Set(['idle', 'running', 'waiting', 'ended']);
  return allowed.has(status) ? status : 'idle';
}

function mapTask(task) {
  if (!task?.id) {
    return null;
  }

  return {
    id: task.id,
    title: String(task.title ?? '').trim(),
    description: String(task.description ?? '').trim(),
    executorId: String(task.executorId ?? '').trim(),
    status: normalizeTaskStatus(task.status),
    linkedSessionId: task.linkedSessionId ? String(task.linkedSessionId) : null,
    lastRunAt: task.lastRunAt ?? null,
    lastStatusAt: task.lastStatusAt ?? null,
    lastTerminalActivityAt: task.lastTerminalActivityAt ?? null,
    lastTerminalOutput: task.lastTerminalOutput ? String(task.lastTerminalOutput) : null,
    createdAt: task.createdAt ?? now(),
    updatedAt: task.updatedAt ?? now(),
  };
}

async function readState() {
  await ensureStore();

  try {
    const raw = await fs.readFile(stateFilePath, 'utf8');
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
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return createDefaultState();
    }

    throw error;
  }
}

async function writeState(state) {
  await ensureStore();
  const payload = JSON.stringify(state, null, 2);
  await fs.writeFile(stateFilePath, payload, 'utf8');
}

export async function ensureStore() {
  await fs.mkdir(dataDir, { recursive: true });
}

export async function readCurrentProject() {
  const state = await readState();
  return state.project;
}

export async function saveCurrentProject(projectPath) {
  const state = await readState();
  const project = mapProject(projectPath);
  await writeState({
    ...state,
    project,
  });

  return project;
}

export async function listTasks() {
  const state = await readState();
  return state.tasks;
}

export async function createTask(input) {
  const title = String(input?.title ?? '').trim();
  const description = String(input?.description ?? '').trim();
  const executorId = String(input?.executorId ?? '').trim();

  if (!title) {
    throw new Error('Task title is required.');
  }

  if (!executorId) {
    throw new Error('Task executorId is required.');
  }

  const state = await readState();
  const timestamp = now();
  const task = mapTask({
    id: crypto.randomUUID(),
    title,
    description,
    executorId,
    status: 'idle',
    linkedSessionId: null,
    lastRunAt: null,
    lastStatusAt: timestamp,
    lastTerminalActivityAt: null,
    lastTerminalOutput: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  state.tasks = [...state.tasks, task];
  await writeState(state);
  return task;
}

export async function getTask(taskId) {
  const tasks = await listTasks();
  return tasks.find((task) => task.id === taskId) ?? null;
}

export async function updateTask(taskId, patch) {
  const state = await readState();
  const index = state.tasks.findIndex((task) => task.id === taskId);

  if (index === -1) {
    return null;
  }

  const currentTask = state.tasks[index];
  const nextTask = mapTask({
    ...currentTask,
    ...patch,
    id: currentTask.id,
    createdAt: currentTask.createdAt,
    updatedAt: now(),
    status: patch?.status ? normalizeTaskStatus(patch.status) : currentTask.status,
  });

  state.tasks[index] = nextTask;
  await writeState(state);
  return nextTask;
}
