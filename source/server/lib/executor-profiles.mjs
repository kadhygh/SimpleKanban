const DEFAULT_SUMMARY_FILE = 'project-summary';

function normalizeSummaryFileName(value) {
  const raw = String(value ?? '').trim();
  const withoutExtension = raw.replace(/\.md$/i, '');
  const sanitized = withoutExtension
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return sanitized || DEFAULT_SUMMARY_FILE;
}

function buildSummaryTarget(params = {}) {
  const fileName = normalizeSummaryFileName(params.summaryFileName ?? params.outputFileName);
  return {
    fileName,
    relativePath: `docs/${fileName}.md`,
  };
}

function buildPowerShellSummaryCommand(params = {}) {
  const target = buildSummaryTarget(params);

  return [
    'New-Item -ItemType Directory -Force docs | Out-Null',
    `$summaryPath = '${target.relativePath}'`,
    "$timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'",
    `@('# Project Summary', '', 'Generated: ' + $timestamp, '', '## Files', '') | Set-Content -Encoding UTF8 $summaryPath`,
    "Get-ChildItem -Recurse -File | Where-Object { $_.FullName -notmatch '\\\\node_modules\\\\|\\\\.git\\\\' } | ForEach-Object { '- ' + $_.FullName.Substring($PWD.Path.Length + 1).Replace('\\', '/') } | Add-Content -Encoding UTF8 $summaryPath",
    'Write-Host "Generated $summaryPath"',
  ].join('; ');
}

function buildBashSummaryCommand(params = {}) {
  const target = buildSummaryTarget(params);

  return [
    'mkdir -p docs',
    `summary_path="${target.relativePath}"`,
    'timestamp="$(date +"%Y-%m-%d %H:%M:%S")"',
    'printf "# Project Summary\n\nGenerated: %s\n\n## Files\n\n" "$timestamp" > "$summary_path"',
    "find . -type f ! -path './node_modules/*' ! -path './.git/*' | sed 's#^\\./##' | while read -r file; do printf -- '- %s\\n' \"$file\"; done >> \"$summary_path\"",
    'printf "Generated %s\\n" "$summary_path"',
  ].join('; ');
}

function buildSummaryCommand(params = {}) {
  if (process.platform === 'win32') {
    return buildPowerShellSummaryCommand(params);
  }

  return buildBashSummaryCommand(params);
}

const executorProfiles = [
  {
    id: 'project-summary-doc',
    name: '生成项目总结文档',
    description: '向当前终端注入一条命令，生成 docs 下的项目总结文档作为执行器样例。',
    params: [
      {
        id: 'summaryFileName',
        label: '输出文件名',
        description: '输入生成到 docs 目录下的 Markdown 文件名，不含 .md 也可以。',
        defaultValue: DEFAULT_SUMMARY_FILE,
      },
    ],
    buildCommand: buildSummaryCommand,
  },
];

export function listExecutorProfiles() {
  return executorProfiles.map((profile) => ({
    id: profile.id,
    name: profile.name,
    description: profile.description,
    params: profile.params,
    commandPreview: profile.buildCommand({
      summaryFileName: profile.params?.[0]?.defaultValue,
    }),
  }));
}

export function getExecutorProfile(executorId) {
  return executorProfiles.find((profile) => profile.id === executorId) ?? null;
}

export function buildExecutorCommand(executorId, params = {}) {
  const profile = getExecutorProfile(executorId);

  if (!profile) {
    throw new Error(`Unknown executor profile: ${executorId}`);
  }

  return profile.buildCommand(params);
}

export function normalizeExecutorParams(executorId, params = {}) {
  const profile = getExecutorProfile(executorId);

  if (!profile) {
    throw new Error(`Unknown executor profile: ${executorId}`);
  }

  if (executorId === 'project-summary-doc') {
    const target = buildSummaryTarget(params);
    return {
      summaryFileName: target.fileName,
      summaryRelativePath: target.relativePath,
    };
  }

  return {};
}
