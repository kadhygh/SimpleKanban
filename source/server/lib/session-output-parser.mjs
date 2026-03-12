function normalizeText(value) {
  return String(value ?? '').toLowerCase();
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
    events.push({
      type: 'parsed_event',
      eventName: 'session.waiting',
      detail: '检测到当前 Session 需要人工输入或确认。',
      rawText: String(data ?? '').slice(-500),
    });
  }

  return events;
}

export function createSessionResumedEvent() {
  return {
    type: 'parsed_event',
    eventName: 'session.resumed',
    detail: '检测到当前 Session 已收到输入，等待态已恢复为运行中。',
  };
}
