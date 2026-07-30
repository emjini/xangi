import {
  Events,
  Message,
  Client,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
} from 'discord.js';
import type { Config } from '../config.js';
import type { AgentRunner } from '../agent-runner.js';
import { formatAgentErrorForUser, shouldSendErrorFollowUp } from '../errors.js';
import { consumeRestartNote } from '../restart-note.js';
import { ClaudeCodeRunner } from '../claude-code.js';
import { runWithBubbleEvents } from '../bubble-events-runner.js';
import { threadIdFor, turnIdFor } from '../events-emitter.js';
import { join } from 'path';
import {
  downloadFile,
  buildAttachmentResult,
  buildPromptWithAttachments,
  extractFilePaths,
  stripFilePaths,
} from '../file-utils.js';
import { splitMessage } from '../message-split.js';
import { DISCORD_MAX_LENGTH, DISCORD_SAFE_LENGTH } from '../constants.js';
import { StreamSession } from '../stream-session.js';
import { registerStreamFinalizer } from '../stream-finalizer.js';
import { buildCompletionNotification } from './completion-notify.js';
import {
  getChannelAutoReply,
  getChannelCompletionNotifyMode,
  getChannelThreadMode,
  loadReplySuggestionsEnabled,
  loadSettings,
} from '../settings.js';
import { waitBeforeFollowupDiscordSend } from './send-delay.js';
import { TurnLatencyRecorder } from '../turn-latency.js';
import {
  getSession,
  setSession,
  ensureSession,
  incrementMessageCount,
  getActiveSessionId,
  getSessionEntry,
  updateSessionTitle,
} from '../sessions.js';
import { stripPromptMetadata } from '../session-title.js';
import { deriveThreadTitle } from './thread-title.js';
import {
  buildDiscordChannelContextLine,
  getDiscordChannelTopic,
  resolveConversationChannelId,
  resolveDiscordSettingsChannelId,
} from './thread-context.js';
import {
  attachPlatformMessageIdToLast,
  findEntryByPlatformMessageId,
  updateMessageContent as updateTranscriptContent,
  deleteMessage as deleteTranscriptMessage,
} from '../transcript-logger.js';
import {
  createProcessingButtons,
  createCompletedButtons,
  getDiscordTimeoutInfoFor,
  discordProcessingMessages,
  discordToolHistoryByMessageId,
  discordReplySuggestionsByMessageId,
} from './ui.js';
import {
  appendReplySuggestionInstruction,
  fallbackReplySuggestions,
  resolveReplySuggestionSkipPermissions,
  sanitizeReplySuggestionOutput,
  stripReplySuggestionMarkup,
} from '../reply-suggestions.js';
import { appendToolHistory, addToolHistory } from '../tool-history.js';
import {
  fetchDiscordLinkContent,
  fetchReplyContent,
  fetchThreadStarterContent,
  fetchChannelMessages,
  annotateChannelMentions,
  prefetchDiscordHistory,
} from './message-utils.js';
import { buildPrefetchedHistoryBlock } from '../prefetched-history.js';

import {
  createThreadStateController,
  type ThreadStateController,
} from './thread-state.js';
import {
  addParkedItem,
  takeParkedItems,
  commitTake,
  restoreTake,
} from '../park.js';

// スレッド状態(🟢🟡🔵)コントローラ。registerDiscordMessageHandlers で client を得てから初期化する。
// processPrompt は上流の呼び出し側が5箇所あり引数追加は衝突面を広げるため、モジュールスコープで保持する。
let threadState: ThreadStateController | null = null;

// park拾い上げの1ターンあたり最大サイクル数（無限ループ防止。超過分は次ターンへ繰り越し）
const MAX_PARK_PICKUP_CYCLES = 5;


/** park された内容を、拾い上げターン用のプロンプトに整形する */
function buildParkPrompt(content: string): string {
  return (
    '【park：作業中に届いた追加メモ】\n' +
    '直前の作業は完了しています。以下はユーザーが作業中に park（一時保存）した追加の依頼・情報です。' +
    '内容を確認し、対応が必要なものに取り組んでください。複数あれば順に対応を。\n' +
    '「📎添付:」の後にファイルの絶対パスがある場合は、必ず Read でその内容（画像等）を確認してから対応すること。\n\n' +
    content
  );
}


/**
 * リクエスト起点のない応答（バックグラウンドタスクの完了通知への応答など）をチャンネルへ配信する。
 *
 * 上流は currentItem が無いターンの応答を破棄するため、persistent-runner が
 * 'unsolicited-message' を emit → runner-manager が中継 → ここで Discord へ送る。
 *
 * ⭐ 自作の !discord/!schedule テキストパースは移植していない（上流の xangi-cmd 方式へ
 *    乗り換えたため）。よってここでは添付抽出と分割送信だけを行えばよい。
 */
export async function deliverUnsolicitedResponse(
  client: Client,
  channelId: string,
  result: string
): Promise<void> {
  try {
    if (!channelId || channelId === '__default__') {
      console.warn('[xangi] Unsolicited response has no channel context. Dropping.');
      return;
    }
    const channel = await client.channels.fetch(channelId);
    if (!channel || !('send' in channel)) {
      console.warn(`[xangi] Unsolicited response channel ${channelId} is not sendable.`);
      return;
    }
    const sendable = channel as unknown as {
      send: (content: string | { files: { attachment: string }[] }) => Promise<unknown>;
    };

    const filePaths = extractFilePaths(result);
    const displayText = filePaths.length > 0 ? stripFilePaths(result) : result;

    if (displayText.trim()) {
      for (const chunk of splitMessage(displayText, DISCORD_SAFE_LENGTH)) {
        await sendable.send(chunk);
      }
    }

    if (filePaths.length > 0) {
      try {
        await sendable.send({ files: filePaths.map((fp: string) => ({ attachment: fp })) });
        console.log(`[xangi] Sent ${filePaths.length} file(s) (unsolicited)`);
      } catch (err) {
        console.error('[xangi] Failed to send files (unsolicited):', err);
      }
    }

    console.log(
      `[xangi] Delivered unsolicited response to channel ${channelId} (${result.length} chars)`
    );
  } catch (err) {
    console.error('[xangi] Failed to deliver unsolicited response:', err);
  }
}

export function shouldProcessDiscordMessage(input: { system?: boolean }): boolean {
  return !input.system;
}

export interface DiscordMessageTarget {
  conversationChannelId: string;
  settingsChannelId: string;
  createdThreadName: string | null;
  threadName: string | null;
  parentChannelName: string | null;
  isThread: boolean;
  outputChannel: {
    send: (options: unknown) => Promise<Message>;
  };
  sendInitial: (options: Parameters<Message['reply']>[0]) => Promise<Message>;
}

async function resolveDiscordMessageTarget(
  message: Message,
  channelId: string,
  config: Config,
  settings: ReturnType<typeof loadSettings>
): Promise<DiscordMessageTarget> {
  let newThread: {
    id: string;
    name?: string;
    send: (options: unknown) => Promise<Message>;
  } | null = null;
  const replyInThread = getChannelThreadMode(
    settings,
    channelId,
    config.discord.replyInThread ?? false
  );

  if (replyInThread) {
    const ch = message.channel as unknown as { isThread?: () => boolean };
    const alreadyThread = typeof ch.isThread === 'function' && ch.isThread();
    const canStartThread =
      typeof (message as unknown as { startThread?: unknown }).startThread === 'function';
    if (!alreadyThread && canStartThread) {
      try {
        const threadName = deriveThreadTitle(message.content);
        newThread = (await (
          message as unknown as {
            startThread: (opts: { name: string }) => Promise<unknown>;
          }
        ).startThread({ name: threadName })) as {
          id: string;
          name?: string;
          send: (options: unknown) => Promise<Message>;
        };
      } catch (err) {
        console.warn(
          '[xangi] Failed to start thread, falling back to channel:',
          (err as Error)?.message
        );
      }
    }
  }

  const conversationChannelId = resolveConversationChannelId(channelId, newThread?.id);
  const settingsChannelId = resolveDiscordSettingsChannelId(channelId, message.channel);
  const outputChannel = (newThread ?? (message.channel as unknown)) as {
    send: (options: unknown) => Promise<Message>;
  };
  const sourceChannel = message.channel as unknown as { isThread?: () => boolean };
  const isThread =
    newThread !== null ||
    (typeof sourceChannel.isThread === 'function' && sourceChannel.isThread());
  const sourceChannelDetails = message.channel as unknown as {
    name?: string;
    parent?: { name?: string } | null;
  };
  const sourceChannelName = sourceChannelDetails.name ?? null;
  const threadName = isThread ? (newThread?.name ?? sourceChannelName) : null;
  const parentChannelName = isThread
    ? newThread
      ? sourceChannelName
      : (sourceChannelDetails.parent?.name ?? null)
    : null;

  return {
    conversationChannelId,
    settingsChannelId,
    createdThreadName: newThread?.name ?? null,
    threadName,
    parentChannelName,
    isThread,
    outputChannel,
    sendInitial: (options: Parameters<Message['reply']>[0]) =>
      newThread ? newThread.send(options) : message.reply(options),
  };
}

export async function processPrompt(
  message: Message,
  agentRunner: AgentRunner,
  prompt: string,
  skipPermissions: boolean,
  channelId: string,
  config: Config,
  target: DiscordMessageTarget,
  actor?: { id: string; name: string; messageId: string; react?: boolean }
): Promise<string | null> {
  const startedAt = Date.now();
  let replyMessage: Message | null = null;
  const toolHistory: string[] = []; // 完了後に表示する短いツール履歴
  // 表示状態のコア。エラー時に途中テキスト・ツール行を残すため関数スコープに置く
  let streamSession: StreamSession | null = null;
  // プロセス終了時に実行中表示を「中断」表示で確定させる finalizer の登録解除関数 (issue #293)
  let unregisterStreamFinalizer: (() => void) | undefined;
  const sourceMessageId = actor?.messageId ?? message.id;
  const turnId = turnIdFor('discord', sourceMessageId);
  const channelName = 'name' in message.channel ? (message.channel as { name: string }).name : null;
  const threadLabel = channelName ? `#${channelName}` : 'DM';
  // MessageCreate 側でスレッド作成を済ませ、確定済みの runKey を渡す。
  // 以降のセッション / runner / timeout UI / Stop はこのキーに揃える。
  const conversationChannelId = target.conversationChannelId;
  const settingsChannelId = target.settingsChannelId;
  const existingProviderSessionId = getSession(conversationChannelId);
  const latency = new TurnLatencyRecorder({
    platform: 'discord',
    turnId,
    threadId: threadIdFor('discord', conversationChannelId),
    configuredBackend: config.agent.backend,
    configuredModel: config.agent.config.model,
    firstTurn: !existingProviderSessionId,
    receivedAt: message.createdTimestamp,
    workdir: config.agent.config.workdir,
  });
  // 応答が長引いたらスレッドを🔵にする（完了時/エラー時に確定状態で上書きされる）
  const threadStatusTimer = threadState?.startBlueTimer(message.channel);
  try {
    console.log(
      `[xangi] Processing message in channel ${channelId}, runKey ${conversationChannelId}`
    );
    if (actor?.react !== false) await message.react('👀').catch(() => {});

    const useStreaming = config.discord.streaming ?? true;
    const showThinking = config.discord.showThinking ?? true;
    const toolHistoryMode =
      config.discord.toolHistoryMode ?? ((config.discord.showToolUse ?? true) ? 'inline' : 'off');
    const captureToolUse = toolHistoryMode !== 'off';
    const showLiveToolUse = captureToolUse && (config.discord.showLiveToolUse ?? true);

    // !skip プレフィックスの場合、ワンショットランナーを使用
    // （persistent-runner はプロセス起動時の権限設定を変えられないため）
    const defaultSkip = config.agent.config.skipPermissions ?? false;
    const needsSkipRunner = skipPermissions && !defaultSkip;
    const runner: AgentRunner = needsSkipRunner
      ? new ClaudeCodeRunner(config.agent.config)
      : agentRunner;

    if (needsSkipRunner) {
      console.log(`[xangi] Using one-shot skip runner for channel ${channelId}`);
    }

    const showButtons = config.discord.showButtons ?? true;

    // ストリーミング表示のプラットフォーム非依存コア (stream-session.ts)。
    // Discord 固有の描画 (message.edit / ボタン行 / 文字数制限) はこの render に集約する
    const session = new StreamSession({
      formatToolLine: showLiveToolUse
        ? (toolName, toolInput) => {
            const lines: string[] = [];
            addToolHistory(lines, toolName, toolInput);
            return lines[0] ?? null;
          }
        : undefined,
      render: async (view) => {
        if (!replyMessage) return;
        const content =
          view.phase === 'thinking'
            ? `${view.toolLines.length > 0 ? `${view.toolLines.join('\n')}\n\n` : ''}${view.statusLine}`
            : appendToolHistory(stripReplySuggestionMarkup(view.text), view.toolLines, ' ▌').slice(
                0,
                DISCORD_MAX_LENGTH
              );
        const payload: { content: string; components?: ActionRowBuilder<ButtonBuilder>[] } = {
          content,
        };
        if (showButtons && !needsSkipRunner) {
          payload.components = [
            createProcessingButtons(getDiscordTimeoutInfoFor(agentRunner, conversationChannelId)),
          ];
        }
        await replyMessage.edit(payload).catch((err) => {
          console.error('[xangi] Failed to edit message:', err?.message);
        });
      },
    });
    streamSession = session;

    const settings = loadSettings();

    if (!existingProviderSessionId && config.historyPrefetch?.enabled) {
      const prefetchedHistory = target.createdThreadName
        ? buildPrefetchedHistoryBlock('Discord', [])
        : await prefetchDiscordHistory(message, config.historyPrefetch.count);
      prompt = `${prefetchedHistory}\n\n${prompt}`;
    }

    // チャンネル・ユーザー情報をプロンプトに付与
    const actorName = actor?.name ?? message.author.displayName ?? message.author.username;
    const actorId = actor?.id ?? message.author.id;
    const userInfo = `[発言者: ${actorName} (ID: ${actorId})]`;
    const channelContextLine = buildDiscordChannelContextLine({
      channelName,
      conversationChannelId,
      settingsChannelId,
      threadName: target.threadName,
      parentChannelName: target.parentChannelName,
    });
    if (channelContextLine) {
      prompt = `[プラットフォーム: Discord]\n${channelContextLine}\n${userInfo}\n${prompt}`;
    } else {
      prompt = `${userInfo}\n${prompt}`;
    }

    // xangi-events 用 ID（fire-and-forget なのでエラーで本業を止めない）
    const threadId = threadIdFor('discord', conversationChannelId);
    const eventCtx = {
      threadId,
      turnId,
      threadLabel,
      platform: 'discord' as const,
      userText: message.content || undefined,
    };

    const sessionId = existingProviderSessionId;
    const appSessionId = ensureSession(conversationChannelId, { platform: 'discord' });

    // 再起動直後の resume では、直前の未完了 tool 呼び出しが 'rejected' として
    // 記録されている（ユーザー拒否ではない）。誤解釈防止の注記を一度だけ注入する
    const restartNote = consumeRestartNote(conversationChannelId, !!sessionId);
    if (restartNote) {
      prompt = `${restartNote}\n${prompt}`;
    }

    const replySuggestionCount = config.discord.replySuggestionCount ?? 3;
    const replySuggestionsEnabled =
      showButtons && loadReplySuggestionsEnabled(config.discord.replySuggestions !== false);
    if (replySuggestionsEnabled) {
      prompt = appendReplySuggestionInstruction(prompt, replySuggestionCount);
    }

    // 以降の追加投稿（続きチャンク・ファイル・完了通知）の送信先。
    const outputChannel = target.outputChannel;

    // 最初のメッセージを送信
    const firstPayload = {
      content: session.view().statusLine,
      ...(showButtons && { components: [createProcessingButtons()] }),
    };
    replyMessage = await target.sendInitial(firstPayload);
    latency.markInitialReply();

    // タイムアウト UI の自動更新対象として登録 (runner.timeout-* で edit される)
    // runner が agentRunner (DynamicRunnerManager) 経由のときのみ — needsSkipRunner で
    // 別個に作った ClaudeCodeRunner には timeout イベントが流れないのでスキップ
    if (showButtons && !needsSkipRunner) {
      discordProcessingMessages.set(conversationChannelId, { message: replyMessage });
    }

    // プロセス再起動 (SIGTERM) で turn が中断されたとき、ストリーミング表示
    // (ツール行 + ▌ / スピナー) を放置せず「中断」表示で確定させる (issue #293)
    unregisterStreamFinalizer = registerStreamFinalizer(async () => {
      session.finish();
      if (!replyMessage) return;
      const view = session.view();
      const note = '⏸ プロセス再起動により中断されました';
      const visibleText = stripReplySuggestionMarkup(view.text);
      const body = visibleText ? `${visibleText}\n\n${note}` : note;
      const content = appendToolHistory(body, view.toolLines).slice(0, DISCORD_MAX_LENGTH);
      await replyMessage.edit({ content, components: [] }).catch(() => {});
    });

    let result: string;
    let newSessionId: string;
    let structuredAttachments: string[] | undefined;

    // 完了後ツール履歴の蓄積（表示は StreamSession 側、こちらは完了後の inline/button 表示用）
    const captureCallbacks = {
      onBackendReady: () => latency.markBackendReady(),
      onToolUse: (toolName: string, toolInput: Record<string, unknown>) => {
        latency.markActivity();
        if (captureToolUse) addToolHistory(toolHistory, toolName, toolInput);
      },
      onText: () => latency.markText(),
    };

    if (useStreaming && showThinking && !needsSkipRunner) {
      // ストリーミング + 思考表示モード（persistent-runner のみ）
      session.start();
      latency.markAgentStart();
      let streamResult: { result: string; sessionId: string };
      try {
        streamResult = await runWithBubbleEvents(
          agentRunner,
          prompt,
          eventCtx,
          session.callbacks(captureCallbacks),
          {
            skipPermissions,
            sessionId,
            channelId: conversationChannelId,
            settingsChannelId,
            appSessionId,
          }
        );
      } finally {
    if (threadStatusTimer) clearTimeout(threadStatusTimer);
        session.finish();
      }
      result = streamResult.result;
      newSessionId = streamResult.sessionId;
      latency.markAgentComplete();
    } else {
      // 非ストリーミング or ワンショットskipランナー
      // useStreaming=false の意図（本文の逐次表示をしない）を保つため onText は渡さず、
      // 思考中アニメーションとツール行だけ更新する
      session.start();
      latency.markAgentStart();
      const sessionCallbacks = session.callbacks(captureCallbacks);
      try {
        const runResult = await runWithBubbleEvents(
          runner,
          prompt,
          eventCtx,
          { onToolUse: sessionCallbacks.onToolUse },
          {
            skipPermissions,
            sessionId,
            channelId: conversationChannelId,
            settingsChannelId,
            appSessionId,
          }
        );
        result = runResult.result;
        newSessionId = runResult.sessionId;
        structuredAttachments = runResult.attachments;
        latency.markAgentComplete();
      } finally {
        session.finish();
      }
    }

    setSession(conversationChannelId, newSessionId);
    incrementMessageCount(appSessionId);
    // transcript の最後の user / assistant エントリに Discord の messageId を
    // 紐付ける。これがあれば後で messageUpdate / messageDelete から jsonl を
    // 逆引きできる。runner 側を触らず post-hoc で attach する戦略。
    try {
      const tWorkdir = config.agent.config.workdir || process.cwd();
      attachPlatformMessageIdToLast(tWorkdir, appSessionId, 'user', sourceMessageId);
      if (replyMessage) {
        attachPlatformMessageIdToLast(tWorkdir, appSessionId, 'assistant', replyMessage.id);
      }
    } catch (err) {
      console.warn('[xangi] Failed to attach platform message ids:', err);
    }
    // 最初のメッセージでタイトル自動設定（既にタイトル付き or 抽出できなければ何もしない）
    const existingEntry = getSessionEntry(appSessionId);
    if (existingEntry && !existingEntry.title) {
      const titleCandidate = stripPromptMetadata(prompt).slice(0, 50);
      if (titleCandidate) {
        updateSessionTitle(appSessionId, titleCandidate);
      }
    }
    console.log(
      `[xangi] Response length: ${result.length}, session: ${newSessionId.slice(0, 8)}...`
    );

    // ファイルパスを抽出して添付送信（テキスト由来 + 構造化 attachments を合算・重複排除）
    const extracted = sanitizeReplySuggestionOutput(
      result,
      replySuggestionsEnabled,
      replySuggestionCount
    );
    if (replySuggestionsEnabled && extracted.suggestions.length === 0) {
      extracted.suggestions = fallbackReplySuggestions(replySuggestionCount);
    }
    const { filePaths, displayText } = buildAttachmentResult(extracted.text, structuredAttachments);
    const displayTextWithTools =
      toolHistoryMode === 'inline' ? appendToolHistory(displayText, toolHistory) : displayText;
    const showToolsButton =
      toolHistoryMode === 'button' &&
      (config.discord.showToolButton ?? true) &&
      toolHistory.length > 0;
    if (showToolsButton && replyMessage) {
      discordToolHistoryByMessageId.set(replyMessage.id, [...toolHistory]);
    } else if (replyMessage) {
      discordToolHistoryByMessageId.delete(replyMessage.id);
    }
    if (replyMessage && showButtons && extracted.suggestions.length > 0) {
      discordReplySuggestionsByMessageId.set(replyMessage.id, extracted.suggestions);
    } else if (replyMessage) {
      discordReplySuggestionsByMessageId.delete(replyMessage.id);
    }

    // === セパレータで明示的に分割（content-digest等で複数投稿を1応答に含める用途）
    // LLMが前後に空白や余分な改行を入れることがあるため、正規表現で緩くマッチ
    const SEPARATOR_REGEX = /\n\s*===\s*\n/;
    const messageParts = SEPARATOR_REGEX.test(displayTextWithTools)
      ? displayTextWithTools
          .split(SEPARATOR_REGEX)
          .map((p) => p.trim())
          .filter(Boolean)
      : [displayTextWithTools];

    // 最初のパートは既存のreplyMessageを編集して送信
    const firstChunks = splitMessage(messageParts[0], DISCORD_SAFE_LENGTH);
    await replyMessage!.edit({
      content: firstChunks[0] || '✅',
      ...(showButtons && {
        components: [
          createCompletedButtons({
            showTools: showToolsButton,
            showLeave: target.isThread,
            showReplySuggestions: extracted.suggestions.length > 0,
          }),
        ],
      }),
    });

    if ('send' in outputChannel) {
      const channel = outputChannel as unknown as {
        send: (content: string) => Promise<unknown>;
      };
      // 最初のパートの残りチャンク
      for (let i = 1; i < firstChunks.length; i++) {
        await waitBeforeFollowupDiscordSend();
        await channel.send(firstChunks[i]);
      }
      // 2つ目以降のパートは新規メッセージとして送信
      for (let p = 1; p < messageParts.length; p++) {
        const chunks = splitMessage(messageParts[p], DISCORD_SAFE_LENGTH);
        for (const chunk of chunks) {
          await waitBeforeFollowupDiscordSend();
          await channel.send(chunk);
        }
      }
    }

    if (filePaths.length > 0 && 'send' in outputChannel) {
      try {
        await (
          outputChannel as unknown as {
            send: (options: { files: { attachment: string }[] }) => Promise<unknown>;
          }
        ).send({
          files: filePaths.map((fp) => ({ attachment: fp })),
        });
        console.log(`[xangi] Sent ${filePaths.length} file(s) to Discord`);
      } catch (err) {
        console.error('[xangi] Failed to send files:', err);
      }
    }

    const completionNotification = buildCompletionNotification({
      mode: getChannelCompletionNotifyMode(
        settings,
        settingsChannelId,
        config.discord.completionNotifyMode ?? 'message'
      ),
      elapsedMs: Date.now() - startedAt,
      thresholdMs: config.discord.completionNotifyAfterMs ?? 10_000,
      userId: message.author.id,
    });
    if (completionNotification && 'send' in outputChannel) {
      await (
        outputChannel as unknown as {
          send: (options: {
            content: string;
            allowedMentions: { parse: []; users?: string[] };
          }) => Promise<unknown>;
        }
      ).send(completionNotification);
    }

    latency.finish('complete');

    // 応答末尾のステータスタグ（🟢🟡🔵）を読み取ってスレッドへ反映
    await threadState
      ?.applyThreadStateFromResponse(extracted.text, message, channelId)
      .catch((e) => console.error('[thread-status] apply failed:', e));

    return extracted.text;
  } catch (error) {
    latency.markAgentComplete();
    streamSession?.finish();
    if (error instanceof Error && error.message === 'Request cancelled by user') {
      console.log('[xangi] Request cancelled by user');
      const lastStreamedText = streamSession?.lastText ?? '';
      const prefix = lastStreamedText ? lastStreamedText + '\n\n' : '';
      const stoppedText = appendToolHistory(
        `${prefix}🛑 停止しました`,
        streamSession?.currentToolLines ?? []
      );
      await replyMessage
        ?.edit({
          content: stoppedText.slice(0, DISCORD_MAX_LENGTH),
          components: [],
        })
        .catch(() => {});
      latency.finish('cancelled');
      return null;
    }
    console.error('[xangi] Error:', error);

    // エラーの種類を判別して詳細メッセージを生成（分類ロジックは errors.ts に共通化）
    const errorDetail = formatAgentErrorForUser(error, {
      timeoutMs: config.agent.config.timeoutMs ?? 300000,
    });

    // エラー詳細を表示（途中のテキスト・ツール履歴を残す）
    const lastStreamedText = streamSession?.lastText ?? '';
    const prefix = lastStreamedText ? lastStreamedText + '\n\n' : '';
    const errorMessage = appendToolHistory(
      `${prefix}${errorDetail}`,
      streamSession?.currentToolLines ?? []
    ).slice(0, DISCORD_MAX_LENGTH);
    if (replyMessage) {
      await replyMessage.edit({ content: errorMessage, components: [] }).catch(() => {});
    } else {
      await message.reply(errorMessage).catch(() => {});
      // エラー時はえみぽぬさんの判断待ち＝🟡
      await threadState?.applyThreadStateFromResponse('🟡', message, channelId).catch(() => {});
    }

    // エラー後にエージェントへ自動フォローアップ。
    // タイムアウト・サーキットブレーカー時は壊れたセッションに負荷を重ねるだけ、
    // 利用上限時はフォローアップ自体が同じ上限に当たるため送らない（判定は errors.ts）
    if (shouldSendErrorFollowUp(error)) {
      try {
        console.log('[xangi] Sending error follow-up to agent');
        const sessionId = getSession(conversationChannelId);
        if (sessionId) {
          const followUpPrompt =
            '先ほどの処理がエラー（タイムアウト等）で中断されました。途中まで行った作業内容と現在の状況を簡潔に報告してください。';
          const followUpAppId = getActiveSessionId(conversationChannelId);
          const followUpResult = await agentRunner.run(followUpPrompt, {
            skipPermissions,
            sessionId,
            channelId: conversationChannelId,
            appSessionId: followUpAppId,
          });
          if (followUpResult.result) {
            setSession(conversationChannelId, followUpResult.sessionId);
            const followUpText = followUpResult.result.slice(0, DISCORD_SAFE_LENGTH);
            // スレッド返信時は replyMessage がスレッド内にあるので、その投稿先へ揃える
            const followUpChannel = (replyMessage?.channel ?? message.channel) as {
              send?: (content: string) => Promise<unknown>;
            };
            if (typeof followUpChannel.send === 'function') {
              await followUpChannel.send(`📋 **エラー前の作業報告:**\n${followUpText}`);
            }
          }
        }
      } catch (followUpError) {
        console.error('[xangi] Error follow-up failed:', followUpError);
      }
    }
    latency.finish('error');

    return null;
  } finally {
    // 正常完了・エラー処理後は shutdown finalizer の対象から外す
    unregisterStreamFinalizer?.();
    // 👀 リアクションを削除
    await message.reactions.cache
      .find((r) => r.emoji.name === '👀')
      ?.users.remove(message.client.user?.id)
      .catch((err) => {
        console.error('[xangi] Failed to remove 👀 reaction:', err.message || err);
      });
  }
}

export async function processReplySuggestion(
  interaction: ButtonInteraction,
  agentRunner: AgentRunner,
  config: Config,
  suggestion: string
): Promise<void> {
  const channel = interaction.channel;
  if (!channel || !('send' in channel)) throw new Error('返信先チャンネルを取得できません');

  const selectedMessage = await channel.send({
    content: `↪ ${suggestion}`,
    allowedMentions: { parse: [] },
  });
  const sourceChannel = channel as unknown as {
    isThread?: () => boolean;
    parentId?: string | null;
    name?: string;
    parent?: { name?: string } | null;
  };
  const isThread = typeof sourceChannel.isThread === 'function' && sourceChannel.isThread();
  const target: DiscordMessageTarget = {
    conversationChannelId: interaction.channelId,
    settingsChannelId: resolveDiscordSettingsChannelId(interaction.channelId, sourceChannel),
    createdThreadName: null,
    threadName: isThread ? (sourceChannel.name ?? null) : null,
    parentChannelName: isThread ? (sourceChannel.parent?.name ?? null) : null,
    isThread,
    outputChannel: channel as unknown as DiscordMessageTarget['outputChannel'],
    sendInitial: (options) => selectedMessage.reply(options),
  };
  await processPrompt(
    selectedMessage,
    agentRunner,
    suggestion,
    resolveReplySuggestionSkipPermissions(config.agent.config.skipPermissions),
    interaction.channelId,
    config,
    target,
    {
      id: interaction.user.id,
      name: interaction.user.displayName ?? interaction.user.username,
      messageId: selectedMessage.id,
      react: false,
    }
  );
}

export interface MessageHandlerDeps {
  client: Client;
  config: Config;
  agentRunner: AgentRunner;
  workdir: string;
}

/**
 * Discord のメッセージ系イベントハンドラを client に登録する。
 * - MessageCreate: メンション / DM / チャンネル別メンションなし応答設定のメッセージを processPrompt に流す
 * - MessageUpdate / MessageDelete: ユーザ操作を transcript jsonl に同期する
 */
export function registerDiscordMessageHandlers(deps: MessageHandlerDeps): void {
  const { client, config, agentRunner, workdir } = deps;
  // park の保存先（index.ts の DATA_DIR 既定と揃える）
  const dataDir = process.env.DATA_DIR || join(workdir, '.xangi');
  // スレッド状態コントローラを初期化（client が必要なためここで）
  threadState = createThreadStateController(client);

  // 自発ターン（バックグラウンドタスク完了通知など）の応答をチャンネルへ配信
  (agentRunner as unknown as {
    on?: (ev: string, cb: (ch: string, text: string) => void) => void;
  }).on?.('unsolicited-message', (ch: string, text: string) => {
    void deliverUnsolicitedResponse(client, ch, text);
  });

  // 実行キー単位の処理中ロック。Discord のスレッド返信モードでは、親チャンネルに
  // 届いた発言から先に thread を作って runKey を確定し、Slack の conversationKey と
  // 同じくスレッドごとに独立してロックする。
  const processingRuns = new Set<string>();

  // 同じ bot からの連続返信を制限するためのカウンタ (channelId → {lastBotId, count})。
  // 別 bot や人間のメッセージが入ったらリセット。RESPOND_TO_BOTS_MAX_CONSECUTIVE で上限制御。
  const consecutiveBotResponses = new Map<string, { lastBotId: string; count: number }>();

  // Discord でユーザがメッセージを編集 → transcript jsonl にも反映する。
  // 対象は active session の jsonl のみ。古いセッションの履歴は対象外
  // (パフォーマンスとマルチセッション衝突回避のため、active のみ)。
  client.on(Events.MessageUpdate, async (_oldMsg, newMsg) => {
    try {
      if (newMsg.partial) {
        try {
          await newMsg.fetch();
        } catch {
          return; // 取得に失敗 (権限不足や削除済み) → 諦める
        }
      }
      if (newMsg.author?.bot) return; // bot 自身の edit (= xangi のストリーム edit) は無視
      const channelId = newMsg.channelId;
      if (!channelId) return;
      const appSessionId = getActiveSessionId(channelId);
      if (!appSessionId) return;

      const entry = findEntryByPlatformMessageId(workdir, appSessionId, newMsg.id);
      if (!entry) return;

      const newContent = newMsg.content ?? '';
      updateTranscriptContent(workdir, appSessionId, entry.id, newContent);
      console.log(
        `[xangi] Synced Discord edit (${newMsg.id}) → transcript ${entry.id} in session ${appSessionId}`
      );
    } catch (err) {
      console.warn('[xangi] Failed to sync Discord edit:', err);
    }
  });

  // Discord でメッセージが削除 → transcript jsonl からも該当行を削除。
  // ユーザの自分メッセージ削除と xangi 自身の bot メッセージ削除の両方に反応
  // (どちらでも platformMessageId が一致すれば削除する)。
  client.on(Events.MessageDelete, async (msg) => {
    try {
      const channelId = msg.channelId;
      if (!channelId) return;
      const appSessionId = getActiveSessionId(channelId);
      if (!appSessionId) return;

      const entry = findEntryByPlatformMessageId(workdir, appSessionId, msg.id);
      if (!entry) return;

      deleteTranscriptMessage(workdir, appSessionId, entry.id);
      console.log(
        `[xangi] Synced Discord delete (${msg.id}) → transcript ${entry.id} in session ${appSessionId}`
      );
    } catch (err) {
      console.warn('[xangi] Failed to sync Discord delete:', err);
    }
  });

  // メッセージ処理
  client.on(Events.MessageCreate, async (message) => {
    if (!shouldProcessDiscordMessage({ system: message.system })) {
      console.log(`[xangi] Skipping Discord system message: ${message.id}`);
      return;
    }

    let isFromAllowedBot = false;
    if (message.author.bot) {
      // 自分自身のメッセージには絶対に反応しない (無限ループ防止)
      if (message.author.id === client.user?.id) return;
      // 機能が OFF なら他 bot メッセージは無視 (既存動作)
      if (!config.discord.respondToBotsEnabled) return;
      // ホワイトリスト判定 (RESPOND_TO_BOTS env / `*` で全許可)
      const allowedBots = config.discord.respondToBots ?? [];
      const allowAll = allowedBots.includes('*');
      const isAllowed = allowAll || allowedBots.includes(message.author.id);
      if (!isAllowed) return;
      // 連続返信制限チェック (default 3 回、0 以下は無制限)
      const maxConsec = config.discord.respondToBotsMaxConsecutive ?? 3;
      if (maxConsec > 0) {
        const counter = consecutiveBotResponses.get(message.channel.id);
        if (counter && counter.lastBotId === message.author.id) {
          if (counter.count >= maxConsec) {
            console.log(
              `[xangi] Consecutive bot response limit reached (${maxConsec}) for bot ${message.author.id} in channel ${message.channel.id}, skipping`
            );
            return;
          }
          counter.count += 1;
        } else {
          consecutiveBotResponses.set(message.channel.id, {
            lastBotId: message.author.id,
            count: 1,
          });
        }
      }
      // bot メッセージだが許可された相手 → 続行 (allowedUsers チェックはバイパス)
      isFromAllowedBot = true;
    } else {
      // 人間のメッセージが入ったら、そのチャンネルの連鎖カウンタをリセット
      consecutiveBotResponses.delete(message.channel.id);
    }

    const isMentioned = message.mentions.has(client.user!);
    const isDM = !message.guild;
    const settings = loadSettings();
    // スレッドは親チャンネルとは別IDを持つため、autoreply 設定はそのままでは継承されない。
    // スレッド内のメッセージは親チャンネル (parentId) の autoreply 状態も見て継承する。
    const threadCh = message.channel as unknown as {
      isThread?: () => boolean;
      parentId?: string | null;
    };
    const parentChannelId =
      typeof threadCh.isThread === 'function' && threadCh.isThread() ? threadCh.parentId : null;
    const isAutoReplyChannel =
      getChannelAutoReply(settings, message.channel.id, false) ||
      (parentChannelId != null && getChannelAutoReply(settings, parentChannelId, false));

    if (!isMentioned && !isDM && !isAutoReplyChannel) return;

    if (
      !isFromAllowedBot &&
      !config.discord.allowedUsers?.includes('*') &&
      !config.discord.allowedUsers?.includes(message.author.id)
    ) {
      console.log(`[xangi] Unauthorized user: ${message.author.id} (${message.author.tag})`);
      return;
    }

    let prompt = message.content
      .replace(/<@[!&]?\d+>/g, '') // ユーザーメンションのみ削除（チャンネルメンションは残す）
      .replace(/\s+/g, ' ')
      .trim();

    // スキップ設定（返信元追加やリンク展開の前に判定する）
    // !skip プレフィックスで一時的にスキップモードにできる
    let skipPermissions = config.agent.config.skipPermissions ?? false;

    if (prompt.startsWith('!skip')) {
      skipPermissions = true;
      prompt = prompt.replace(/^!skip\s*/, '').trim();
    }

    // Discordリンクからメッセージ内容を取得
    prompt = await fetchDiscordLinkContent(client, prompt);

    // 既存スレッド内の発言では、スレッド元メッセージを明示的にプロンプトへ追加する。
    // Discord のスレッド履歴だけでは親チャンネル側の starter message が見えず、
    // 「このスレッドの最初の話題」を取り違えるため。
    const threadStarterContent = await fetchThreadStarterContent(message);
    if (threadStarterContent) {
      prompt = threadStarterContent + prompt;
    }

    // 返信元メッセージを取得してプロンプトに追加
    const replyContent = await fetchReplyContent(message);
    if (replyContent) {
      prompt = replyContent + prompt;
    }

    // チャンネルメンションにID注釈を追加（展開前に実行）
    prompt = annotateChannelMentions(prompt);

    // チャンネルメンションから最新メッセージを取得
    prompt = await fetchChannelMessages(client, prompt);

    // 添付ファイルをダウンロード
    const attachmentPaths: string[] = [];
    if (message.attachments.size > 0) {
      for (const [, attachment] of message.attachments) {
        try {
          const filePath = await downloadFile(attachment.url, attachment.name || 'file');
          attachmentPaths.push(filePath);
        } catch (err) {
          console.error(`[xangi] Failed to download attachment: ${attachment.name}`, err);
        }
      }
    }

    // テキストも添付もない場合はスキップ
    if (!prompt && attachmentPaths.length === 0) return;

    // 添付ファイル情報をプロンプトに追加
    prompt = buildPromptWithAttachments(
      prompt || '添付ファイルを確認してください',
      attachmentPaths
    );

    const channelId = message.channel.id;

    // チャンネルトピック（概要）をプロンプトに注入
    if (config.discord.injectChannelTopic !== false) {
      const topic = getDiscordChannelTopic(message.channel);
      if (topic) {
        prompt += `\n\n[チャンネルルール（必ず従うこと）]\n${topic}`;
      }
    }

    // タイムスタンプをプロンプトの先頭に注入
    if (config.discord.injectTimestamp !== false) {
      const d = new Date();
      const now = d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
      const day = d.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', weekday: 'short' });
      prompt = `[現在時刻: ${now}(${day})]\n${prompt}`;
    }

    const target = await resolveDiscordMessageTarget(message, channelId, config, settings);
    const runKey = target.conversationChannelId;

    // !park: 作業中でも受け取れるクイックストック。エージェントを起動せず溜めるだけ。
    // busyガードより前に処理する（＝処理中でも park できる）。次のターン完了後に自動で拾い上げる。
    {
      const parkRaw = message.content.replace(/<@[!&]?\d+>/g, '').trim();
      if (parkRaw === '!park' || /^!park\s/.test(parkRaw)) {
        const body = parkRaw.replace(/^!park\s*/, '').trim();
        const parkAttachments: string[] = [];
        for (const attachment of message.attachments.values()) {
          try {
            const fp = await downloadFile(attachment.url, attachment.name || 'file');
            if (fp) parkAttachments.push(fp);
          } catch (err) {
            console.error(`[park] Failed to download attachment: ${attachment.name}`, err);
          }
        }
        // 本文も添付も無ければ park しない
        if (!body && parkAttachments.length === 0) {
          await message.react('❓').catch(() => {});
          return;
        }
        addParkedItem(dataDir, channelId, body, message.author.username, parkAttachments);
        console.log(
          `[park] Parked item in channel ${channelId}` +
            (parkAttachments.length ? ` (+${parkAttachments.length} attachment(s))` : '')
        );
        await message.react('📥').catch(() => {});
        return;
      }
    }

    // 同じ実行キーで処理中なら無視（メンション時は除く）
    if (!isMentioned && processingRuns.has(runKey)) {
      console.log(`[xangi] Skipping message in busy run: ${runKey}`);
      return;
    }

    processingRuns.add(runKey);
    try {
      await processPrompt(message, agentRunner, prompt, skipPermissions, channelId, config, target);

      // park拾い: 現在の作業が終わったら、溜まった park メモを別ターン
      //（＝別タイムアウト枠）で処理する。無限ループ防止に上限サイクルを設ける。
      let parkCycles = 0;
      while (parkCycles < MAX_PARK_PICKUP_CYCLES) {
        const take = takeParkedItems(dataDir, channelId);
        if (!take) break;
        parkCycles++;
        console.log(`[park] Picking up parked items in channel ${channelId} (cycle ${parkCycles})`);
        try {
          const parkPrompt = buildParkPrompt(take.content);
          await processPrompt(
            message,
            agentRunner,
            parkPrompt,
            skipPermissions,
            channelId,
            config,
            target
          );
          commitTake(take);
        } catch (parkErr) {
          restoreTake(dataDir, take);
          console.error('[park] Pickup failed; restored items for next turn:', parkErr);
          break;
        }
      }
      if (parkCycles >= MAX_PARK_PICKUP_CYCLES) {
        console.warn(
          `[park] Reached max pickup cycles in channel ${channelId}; remaining items deferred to next turn`
        );
      }
    } finally {
      processingRuns.delete(runKey);
    }
  });
}
