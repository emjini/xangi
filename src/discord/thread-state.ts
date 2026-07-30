import type { Client, Message } from 'discord.js';
import {
  THREAD_STATUS_EMOJIS,
  buildThreadStateName,
  detectManualThreadState,
  detectThreadState,
  type ThreadStateEmoji,
} from '../thread-status.js';

export type ThreadStateSetter = (threadId: string, emoji: ThreadStateEmoji) => void;

/** 応答が長引いた時に🔵へ落とすまでの待ち時間 */
const configuredBlueThreshold = Number(process.env.THREAD_STATUS_BLUE_THRESHOLD_MS ?? '60000');
export const THREAD_STATUS_BLUE_THRESHOLD_MS = Number.isFinite(configuredBlueThreshold)
  ? configuredBlueThreshold
  : 60000;

function getThreadChannel(channel: unknown): {
id: string;
name: string;
parentId: string | null;
isThread: () => boolean;
setName: (name: string) => Promise<unknown>;
setAppliedTags: (tagIds: readonly string[]) => Promise<unknown>;
} | null {
if (
  channel &&
  typeof (channel as { isThread?: unknown }).isThread === 'function' &&
  (channel as { isThread: () => boolean }).isThread()
) {
  return channel as {
    id: string;
    name: string;
    parentId: string | null;
    isThread: () => boolean;
    setName: (name: string) => Promise<unknown>;
    setAppliedTags: (tagIds: readonly string[]) => Promise<unknown>;
  };
}
return null;
}

function startThreadStatusBlueTimer(
channel: unknown,
setThreadState: ThreadStateSetter
): ReturnType<typeof setTimeout> | undefined {
const thread = getThreadChannel(channel);
if (!thread) return undefined;

return setTimeout(() => {
  try {
    setThreadState(thread.id, '🔵');
  } catch (error) {
    console.error('[xangi] Failed to set delayed thread state:', error);
  }
}, THREAD_STATUS_BLUE_THRESHOLD_MS);
}

export interface ThreadStateController {
  setThreadState: ThreadStateSetter;
  applyThreadStateFromResponse: (
    text: string,
    sourceMessage?: Message,
    fallbackChannelId?: string
  ) => Promise<void>;
  startBlueTimer: (channel: unknown) => ReturnType<typeof setTimeout> | undefined;
}

/**
 * スレッド状態（🟢🟡🔵）の管理コントローラを生成する。
 *
 * 元は index.ts のクロージャ内に居たが、上流が index.ts を402行へ解体したため
 * discord/ 配下の独立モジュールへ移した（2026-07-30 移植）。client を注入して同じ動作を保つ。
 */
export function createThreadStateController(client: Client): ThreadStateController {
  const threadDesiredState = new Map<string, ThreadStateEmoji>();
  const forumTagIdCache = new Map<string, Promise<Map<ThreadStateEmoji, string>>>();
  const renameStates = new Map<string, { desiredName: string; inFlight: boolean }>();

  async function resolveTagId(
    forumId: string,
    emoji: ThreadStateEmoji
  ): Promise<string | undefined> {
    let cached = forumTagIdCache.get(forumId);
    if (!cached) {
      cached = (async () => {
        const forum = await client.channels.fetch(forumId);
        const tagIds = new Map<ThreadStateEmoji, string>();
        if (!forum || !forum.isThreadOnly()) return tagIds;

        for (const tag of forum.availableTags) {
          const tagEmoji = tag.emoji?.name;
          if (tagEmoji && (THREAD_STATUS_EMOJIS as readonly string[]).includes(tagEmoji)) {
            tagIds.set(tagEmoji as ThreadStateEmoji, tag.id);
          }
        }
        return tagIds;
      })();
      forumTagIdCache.set(forumId, cached);
    }

    try {
      return (await cached).get(emoji);
    } catch (error) {
      forumTagIdCache.delete(forumId);
      throw error;
    }
  }

  function applyRename(
    threadId: string,
    thread: { setName: (name: string) => Promise<unknown> }
  ): void {
    const state = renameStates.get(threadId);
    if (!state) return;
    const applyingName = state.desiredName;

    let request: Promise<unknown>;
    try {
      request = thread.setName(applyingName);
    } catch (error) {
      console.error('[xangi] thread-status rename failed:', error);
      if (state.desiredName !== applyingName) {
        applyRename(threadId, thread);
      } else {
        state.inFlight = false;
      }
      return;
    }

    void request
      .catch((error: unknown) => {
        console.error('[xangi] thread-status rename failed:', error);
      })
      .finally(() => {
        const latest = renameStates.get(threadId);
        if (!latest) return;
        if (latest.desiredName !== applyingName) {
          applyRename(threadId, thread);
        } else {
          latest.inFlight = false;
        }
      });
  }

  function setRename(
    threadId: string,
    thread: { setName: (name: string) => Promise<unknown> },
    name: string
  ): void {
    const state = renameStates.get(threadId);
    if (state) {
      state.desiredName = name;
      if (state.inFlight) return;
      state.inFlight = true;
    } else {
      renameStates.set(threadId, { desiredName: name, inFlight: true });
    }
    applyRename(threadId, thread);
  }

  const setThreadState: ThreadStateSetter = (threadId, emoji) => {
    try {
      if (threadDesiredState.get(threadId) === emoji) return;
      threadDesiredState.set(threadId, emoji);

      void (async () => {
        const channel =
          client.channels.cache.get(threadId) ?? (await client.channels.fetch(threadId));
        const thread = getThreadChannel(channel);
        if (!thread) return;

        if (thread.parentId) {
          void resolveTagId(thread.parentId, emoji)
            .then((tagId) => {
              if (!tagId) return;
              void thread.setAppliedTags([tagId]).catch((error: unknown) => {
                console.error('[xangi] thread-status tag update failed:', error);
              });
            })
            .catch((error: unknown) => {
              console.error('[xangi] thread-status tag resolution failed:', error);
            });
        }

        const desiredName = buildThreadStateName(thread.name, emoji);
        if (desiredName !== thread.name || renameStates.get(threadId)?.inFlight) {
          setRename(threadId, thread, desiredName);
        }
      })().catch((error: unknown) => {
        console.error('[xangi] Failed to apply thread state:', error);
      });
    } catch (error) {
      console.error('[xangi] Failed to set thread state:', error);
    }
  };

  async function resolveResponseThread(
    sourceMessage?: Message,
    fallbackChannelId?: string
  ): Promise<ReturnType<typeof getThreadChannel>> {
    try {
      const channel =
        sourceMessage?.channel ??
        (fallbackChannelId ? await client.channels.fetch(fallbackChannelId) : null);
      return getThreadChannel(channel);
    } catch (error) {
      console.error('[xangi] Failed to resolve response thread:', error);
      return null;
    }
  }

  async function applyThreadStateFromResponse(
    text: string,
    sourceMessage?: Message,
    fallbackChannelId?: string
  ): Promise<void> {
    try {
      const thread = await resolveResponseThread(sourceMessage, fallbackChannelId);
      if (!thread) return;

      const manualState = detectManualThreadState(text);
      if (manualState) {
        setThreadState(thread.id, manualState);
        return;
      }

      const detectedState = detectThreadState(text);
      if (detectedState) {
        setThreadState(thread.id, detectedState);
      } else if (threadDesiredState.get(thread.id) === '🔵') {
        setThreadState(thread.id, '🟡');
      }
    } catch (error) {
      console.error('[xangi] Failed to detect thread state:', error);
    }
  }

  return {
    setThreadState,
    applyThreadStateFromResponse,
    startBlueTimer: (channel: unknown) => startThreadStatusBlueTimer(channel, setThreadState),
  };
}
