import { promises as fs } from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve(process.cwd(), 'source/server/data');
const stateFilePath = path.join(dataDir, 'project-state.json');

function mapProject(projectPath) {
  if (!projectPath) {
    return null;
  }

  return {
    name: path.basename(projectPath),
    path: projectPath,
    updatedAt: new Date().toISOString(),
  };
}

export async function ensureStore() {
  await fs.mkdir(dataDir, { recursive: true });
}

export async function readCurrentProject() {
  await ensureStore();

  try {
    const raw = await fs.readFile(stateFilePath, 'utf8');
    const parsed = JSON.parse(raw);

    if (!parsed?.project?.path) {
      return null;
    }

    return {
      name: parsed.project.name ?? path.basename(parsed.project.path),
      path: parsed.project.path,
      updatedAt: parsed.project.updatedAt ?? null,
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

export async function saveCurrentProject(projectPath) {
  await ensureStore();

  const project = mapProject(projectPath);
  const payload = JSON.stringify({ project }, null, 2);
  await fs.writeFile(stateFilePath, payload, 'utf8');

  return project;
}
