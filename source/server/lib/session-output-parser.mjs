function normalizeText(value) {
  return String(value ?? '').toLowerCase();
}

export function createParsedSessionEvent(eventName, detail, extras = {}) {
  return {
    type: 'parsed_event',
    eventName,
    detail,
    ...extras,
  };
}

export function parseSessionOutput(data) {
  const text = normalizeText(data);

  if (!text.trim()) {
    return [];
  }

  const events = [];
  const hasWaitingKeyword = [
    'press any key',
    'continue?',
    'need input',
    'enter input',
    'password',
    'confirm',
    '[y/n]',
    '(y/n)',
    'waiting for input',
    'input required',
    'input:',
    'permission',
    'allow',
  ].some((keyword) => text.includes(keyword));

  const hasWaitingPattern = [
    /\benter\b.{0,20}\b(password|passcode|input|value|choice|selection)\b/,
    /\b(confirm|approve|allow)\b.{0,20}\?/,
    /\b(read-host|prompt)\b/,
    /\b(password|passcode|input|value|choice|selection)\s*:\s*$/,
  ].some((pattern) => pattern.test(text));

  if (hasWaitingKeyword || hasWaitingPattern) {
    events.push(createParsedSessionEvent(
      'session.waiting',
      '检测到当前 Session 需要人工输入或确认。',
      { rawText: String(data ?? '').slice(-500) },
    ));
  }

  return events;
}

export function createSessionResumedEvent() {
  return createParsedSessionEvent(
    'session.resumed',
    '检测到当前 Session 已收到输入，等待态已恢复为运行中。',
  );
}

export function createSessionLifecycleEvent(previousStatus, session) {
  const nextStatus = String(session?.status ?? '').trim();

  if (!nextStatus || previousStatus === nextStatus) {
    return null;
  }

  if (nextStatus === 'running' && (!previousStatus || previousStatus === 'starting')) {
    return createParsedSessionEvent(
      'session.started',
      `Session 已启动：${session?.name ?? (String(session?.id ?? '').slice(0, 8) || '未命名 Session')}`,
    );
  }

  if (nextStatus === 'closed') {
    const exitCodeText = session?.exitCode == null ? 'null' : String(session.exitCode);
    return createParsedSessionEvent(
      'session.closed',
      `Session 已关闭，exitCode=${exitCodeText}`,
      { exitCode: session?.exitCode ?? null },
    );
  }

  if (nextStatus === 'error') {
    return createParsedSessionEvent(
      'session.error',
      session?.error ? `Session 进入错误态：${session.error}` : 'Session 进入错误态。',
      { error: session?.error ?? null },
    );
  }

  return null;
}
