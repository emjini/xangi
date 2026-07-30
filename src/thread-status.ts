export const THREAD_STATUS_EMOJIS = ['🟢', '🟡', '🔵'] as const;
export type ThreadStateEmoji = (typeof THREAD_STATUS_EMOJIS)[number];

export function detectManualThreadState(text: string): ThreadStateEmoji | null {
  let inCodeBlock = false;
  let detectedState: ThreadStateEmoji | null = null;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const match = trimmed.match(/^!discord\s+thread-status\s+(\S+)\s*$/);
    if (!match) continue;
    const emoji = match[1];
    for (const statusEmoji of THREAD_STATUS_EMOJIS) {
      if (emoji === statusEmoji) detectedState = statusEmoji;
    }
  }

  return detectedState;
}

export function detectThreadState(text: string): ThreadStateEmoji | null {
  const nonEmptyLines: { text: string; inCodeBlock: boolean }[] = [];
  let inCodeBlock = false;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const isFence = trimmed.startsWith('```');
    nonEmptyLines.push({ text: trimmed, inCodeBlock: inCodeBlock || isFence });
    if (isFence) inCodeBlock = !inCodeBlock;
  }

  for (const line of nonEmptyLines.slice(-3).reverse()) {
    if (line.inCodeBlock) return null;
    if (
      line.text.startsWith('!discord') ||
      line.text.startsWith('MEDIA:') ||
      line.text.startsWith('SYSTEM_COMMAND:') ||
      line.text.startsWith('FILE:')
    ) {
      continue;
    }
    for (const emoji of THREAD_STATUS_EMOJIS) {
      if (line.text.startsWith(emoji)) return emoji;
    }
    return null;
  }

  return null;
}

export function buildThreadStateName(currentName: string, emoji: ThreadStateEmoji): string {
  let stripped = currentName;
  for (const statusEmoji of THREAD_STATUS_EMOJIS) {
    if (stripped.startsWith(statusEmoji)) {
      stripped = stripped.slice(statusEmoji.length).replace(/^\s+/, '');
      break;
    }
  }
  return `${emoji} ${stripped}`.slice(0, 100);
}
