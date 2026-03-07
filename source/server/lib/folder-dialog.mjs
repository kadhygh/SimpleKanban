import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';

const dialogScript = [
  "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
  "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
  "$dialog.Description = '选择工程文件夹'",
  "$dialog.UseDescriptionForTitle = $true",
  "$dialog.ShowNewFolderButton = $false",
  "$result = $dialog.ShowDialog()",
  "if ($result -eq [System.Windows.Forms.DialogResult]::OK) {",
  "  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "  Write-Output $dialog.SelectedPath",
  "}",
].join('; ');

export async function ensureDirectoryPath(folderPath) {
  if (!folderPath || typeof folderPath !== 'string') {
    throw new Error('Project path is required.');
  }

  await access(folderPath, constants.F_OK);
  return folderPath;
}

export async function selectProjectFolder() {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', dialogScript], {
      windowsHide: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code !== 0 && stdout.trim().length === 0) {
        reject(new Error(stderr.trim() || `Folder dialog exited with code ${code}`));
        return;
      }

      const selectedPath = stdout.trim();
      resolve(selectedPath || null);
    });
  });
}
