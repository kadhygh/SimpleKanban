function buildPowerShellSummaryCommand() {
  return [
    "New-Item -ItemType Directory -Force docs | Out-Null",
    "$summaryPath = 'docs/project-summary.md'",
    "$timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'",
    "@('# Project Summary', '', \"Generated: $timestamp\", '', '## Files', '') | Set-Content -Encoding UTF8 $summaryPath",
    "Get-ChildItem -Recurse -File | Where-Object { $_.FullName -notmatch '\\\\node_modules\\\\|\\\\.git\\\\' } | ForEach-Object { '- ' + $_.FullName.Substring($PWD.Path.Length + 1).Replace('\\', '/') } | Add-Content -Encoding UTF8 $summaryPath",
    "Write-Host \"Generated $summaryPath\"",
  ].join('; ');
}

function buildBashSummaryCommand() {
  return [
    'mkdir -p docs',
    'summary_path="docs/project-summary.md"',
    'timestamp="$(date +"%Y-%m-%d %H:%M:%S")"',
    'printf "# Project Summary\n\nGenerated: %s\n\n## Files\n\n" "$timestamp" > "$summary_path"',
    "find . -type f ! -path './node_modules/*' ! -path './.git/*' | sed 's#^\\./##' | while read -r file; do printf -- '- %s\\n' \"$file\"; done >> \"$summary_path\"",
    'printf "Generated %s\\n" "$summary_path"',
  ].join('; ');
}

function buildSummaryCommand() {
  if (process.platform === 'win32') {
    return buildPowerShellSummaryCommand();
  }

  return buildBashSummaryCommand();
}

const executorProfiles = [
  {
    id: 'project-summary-doc',
    name: '生成项目总结文档',
    description: '向当前终端注入一条命令，生成 docs/project-summary.md 作为执行器样例。',
    buildCommand: buildSummaryCommand,
  },
];

export function listExecutorProfiles() {
  return executorProfiles.map((profile) => ({
    id: profile.id,
    name: profile.name,
    description: profile.description,
    commandPreview: profile.buildCommand(),
  }));
}

export function getExecutorProfile(executorId) {
  return executorProfiles.find((profile) => profile.id === executorId) ?? null;
}

export function buildExecutorCommand(executorId) {
  const profile = getExecutorProfile(executorId);

  if (!profile) {
    throw new Error(`Unknown executor profile: ${executorId}`);
  }

  return profile.buildCommand();
}
