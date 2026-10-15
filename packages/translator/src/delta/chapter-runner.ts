import { SHA256 } from 'crypto-es/lib/sha256';
import type { ToolCall } from '@earendil-works/pi-ai';
import {
  assembleDeltaChapter,
  createDeltaParagraphs,
  planDeltaBatches,
  validateSubmitBatch,
} from './batch';
import {
  buildDeltaBatchPrompt,
  buildDeltaSystemPrompt,
  DELTA_PROMPT_VERSION,
  deltaSubmitBatchTool,
} from './prompt';
import { deltaReviewTools } from './review-prompt';
import type { PiAiSessionRequest, PiAiSessionResult } from './pi-ai-transport';
import type {
  CreateDeltaSessionInput,
  DeltaChapterIdentity,
  DeltaChapterSession,
  DeltaSessionStore,
} from './types';

export function deltaChapterKey(identity: DeltaChapterIdentity): string {
  return JSON.stringify([
    identity.novelId,
    identity.volumeId ?? '',
    identity.chapterId,
  ]);
}

export function deltaFingerprint(value: unknown): string {
  return SHA256(JSON.stringify(value)).toString();
}

export function createDeltaSession(
  input: CreateDeltaSessionInput,
): DeltaChapterSession {
  const frozen = structuredClone(input);
  const paragraphs = createDeltaParagraphs(frozen.source);
  const batches = planDeltaBatches(
    paragraphs,
    frozen.batchMaxChars,
    frozen.batchMaxParagraphs,
  );
  const metadata = frozen.metadata ?? {};
  const preferences = frozen.preferences ?? '';
  const session: DeltaChapterSession = {
    id: deltaChapterKey(frozen.identity),
    runId: frozen.runId,
    workerId: frozen.workerId,
    identity: frozen.identity,
    schemaVersion: 1,
    revision: 0,
    promptVersion: DELTA_PROMPT_VERSION,
    source: frozen.source,
    sourceHash: deltaFingerprint(frozen.source),
    metadata,
    glossaryId: frozen.glossaryId,
    glossary: frozen.glossary,
    preferences,
    model: {
      protocol: frozen.model.protocol,
      endpoint: frozen.model.endpoint,
      model: frozen.model.model,
      profile: frozen.model.profile,
      requestParams: frozen.model.requestParams,
    },
    paragraphs,
    batches,
    cursor: 0,
    translations: {},
    systemPrompt: buildDeltaSystemPrompt(
      metadata,
      preferences,
      frozen.reviewOptions,
    ),
    reviewOptions: frozen.reviewOptions,
    tools: structuredClone(
      frozen.reviewOptions?.enabled && frozen.reviewOptions.mode === 'append'
        ? [deltaSubmitBatchTool, ...deltaReviewTools]
        : [deltaSubmitBatchTool],
    ),
    messages: [],
    promptCursor: -1,
    requests: [],
    retry: {
      batchId: batches[0]?.id ?? '',
      window: 1,
      attempts: 0,
      totalAttempts: 0,
      outputBudgetIncreased: false,
    },
    phase: 'translating',
    previousTranslationHash: frozen.previousTranslationHash,
  };
  if (!batches.length) finish(session);
  return session;
}

export function reopenDeltaRetryWindow(
  session: DeltaChapterSession,
): DeltaChapterSession {
  const next = structuredClone(session);
  const lastRequest = next.requests[next.requests.length - 1];
  // Older checkpoints may already have exhausted a larger batch.
  if (
    lastRequest?.batchId === next.batches[next.cursor]?.id &&
    lastRequest.status === 'rejected' &&
    next.pauseReason &&
    (next.retry.attempts >= 3 || next.retry.outputBudgetIncreased) &&
    splitCurrentBatch(next)
  )
    return next;
  next.retry.window++;
  next.retry.attempts = 0;
  next.pauseReason = undefined;
  if (lastRequest?.status === 'rejected' && lastRequest.error) {
    next.messages.push({
      role: 'user',
      content: buildBatchRepairFeedback(next, lastRequest.error),
      timestamp: Date.now(),
    });
  }
  return next;
}

export interface RunDeltaChapterOptions {
  store: DeltaSessionStore;
  transport: (request: PiAiSessionRequest) => Promise<PiAiSessionResult>;
  key: string;
  signal?: AbortSignal;
  onUpdate?: (session: DeltaChapterSession) => void;
  onThinking?: (text: string) => void;
  retryDelayMs?: number;
}

function finish(session: DeltaChapterSession) {
  session.finalParagraphs = assembleDeltaChapter(session);
  session.finalHash = deltaFingerprint(session.finalParagraphs);
  session.phase =
    session.reviewOptions?.enabled && session.batches.length
      ? 'reviewing'
      : 'readyToSubmit';
  session.pauseReason = undefined;
}

/** Replace only the rejected batch; paragraph IDs, accepted text and native history stay intact. */
function splitCurrentBatch(session: DeltaChapterSession): boolean {
  const batch = session.batches[session.cursor];
  if (!batch || batch.paragraphIds.length < 2) return false;
  const midpoint = Math.ceil(batch.paragraphIds.length / 2);
  const children = [
    {
      id: `${batch.id}.1`,
      paragraphIds: batch.paragraphIds.slice(0, midpoint),
    },
    { id: `${batch.id}.2`, paragraphIds: batch.paragraphIds.slice(midpoint) },
  ];
  session.batches.splice(session.cursor, 1, ...children);
  session.promptCursor = -1;
  session.pauseReason = undefined;
  session.retry = {
    ...session.retry,
    batchId: children[0].id,
    window: 1,
    attempts: 0,
    outputBudgetIncreased: false,
    nextRequestParams: undefined,
  };
  session.messages.push({
    role: 'user',
    content: `批次 ${batch.id} 多次提交失败，已撤销该批授权并按段落顺序二分为 ${children.map((child) => `${child.id}（${child.paragraphIds.length} 段）`).join('、')}。此前失败提交未接受任何译文。接下来仅提交新 current_batch 授权的 ID，不要再次提交旧 batchId，也不要合并两个子批。`,
    timestamp: Date.now(),
  });
  return true;
}

function buildBatchRepairFeedback(
  session: DeltaChapterSession,
  error: string,
): string {
  const batch = session.batches[session.cursor];
  const failures = session.requests.filter(
    (request) => request.batchId === batch.id && request.status === 'rejected',
  );
  const previous = failures[failures.length - 1];
  return [
    `批次 ${batch.id} 校验失败：${error}`,
    previous
      ? `${previous.error === error ? '同一错误再次出现' : '本批已多次提交失败'}（此前 ${failures.length} 次）。请先逐项核对下列授权 ID，修正后再提交，不要重复上一份错误参数。`
      : '',
    `batchId 必须为 ${batch.id}；entries 必须恰好包含 ${batch.paragraphIds.length} 条译文，paragraphId 完整覆盖：${JSON.stringify(batch.paragraphIds)}。`,
    '本次提交未接受任何译文。保留已正确的译文并重新完整提交本批，不能只补缺失项，也不能跳到下一批。',
    '每项仅含 paragraphId 和 translation；translation 必须是非空、无换行的译文。删除越界条目，每个授权 ID 只能出现一次。',
    '仅调用一次 submit_batch，译文写入工具参数；普通正文或思考过程不能代替工具提交。',
  ]
    .filter(Boolean)
    .join('\n');
}

function settlePending(session: DeltaChapterSession) {
  const pending = session.pendingAssistant!;
  const { message } = pending;
  const record = session.requests.find(
    (record) => record.requestId === pending.requestId,
  )!;
  record.usage = message.usage;
  record.usagePresence = pending.usagePresence;
  session.messages.push(message);
  const calls = message.content.filter(
    (block): block is ToolCall => block.type === 'toolCall',
  );
  let error: string | undefined;
  let entries: ReturnType<typeof validateSubmitBatch>['entries'];
  if (message.stopReason === 'length')
    error =
      '模型输出截断；不执行不完整工具调用。请重新生成完整参数，不要续写截断的 JSON。';
  else if (calls.length !== 1)
    error = `每轮必须且只能调用一次 submit_batch，本次调用 ${calls.length} 次。`;
  else if (calls[0].name !== 'submit_batch')
    error = '仅允许 submit_batch 工具。';
  else ({ error, entries } = validateSubmitBatch(session, calls[0].arguments));
  const feedback = error ? buildBatchRepairFeedback(session, error) : undefined;
  for (const call of calls) {
    session.messages.push({
      role: 'toolResult',
      toolCallId: call.id,
      toolName: call.name,
      content: [
        {
          type: 'text',
          text:
            feedback ?? `批次 ${session.batches[session.cursor].id} 已接受。`,
        },
      ],
      isError: !!error,
      timestamp: Date.now(),
    });
  }
  if (error && !calls.length)
    session.messages.push({
      role: 'user',
      content: feedback!,
      timestamp: Date.now(),
    });
  record.status = error ? 'rejected' : 'accepted';
  record.error = error;
  session.pendingAssistant = undefined;
  if (error) {
    if (message.stopReason === 'length') {
      const params =
        session.retry.nextRequestParams ?? session.model.requestParams ?? {};
      const field =
        ['max_output_tokens', 'max_completion_tokens', 'max_tokens'].find(
          (field) => typeof params[field] === 'number',
        ) ??
        (session.model.protocol === 'openai-responses'
          ? 'max_output_tokens'
          : 'max_tokens');
      const limit =
        typeof params[field] === 'number' ? (params[field] as number) : 16384;
      if (session.retry.outputBudgetIncreased || limit >= 32768)
        session.pauseReason =
          '模型输出仍然截断，请调整批次或输出预算后重新开始。';
      else {
        session.retry.outputBudgetIncreased = true;
        session.retry.nextRequestParams = {
          ...params,
          [field]: Math.min(32768, limit * 2),
        };
      }
    }
    if (
      (session.retry.attempts >= 3 || session.pauseReason) &&
      splitCurrentBatch(session)
    )
      return;
    if (session.retry.attempts >= 3)
      session.pauseReason ??= '当前批已达到 3 次请求上限，请显式重试。';
    return;
  }
  for (const entry of entries!)
    session.translations[entry.paragraphId] = entry.translation;
  session.cursor++;
  session.pauseReason = undefined;
  if (session.cursor === session.batches.length) finish(session);
  else
    session.retry = {
      ...session.retry,
      batchId: session.batches[session.cursor].id,
      window: 1,
      attempts: 0,
      outputBudgetIncreased: false,
      nextRequestParams: undefined,
    };
}

/** All state changes are committed as complete snapshots; a failed save never advances local state. */
export async function runDeltaChapter(
  initial: DeltaChapterSession,
  options: RunDeltaChapterOptions,
): Promise<DeltaChapterSession> {
  let session = structuredClone(initial);
  async function commit(change: (next: DeltaChapterSession) => void) {
    const next = structuredClone(session);
    change(next);
    next.revision++;
    await options.store.save(structuredClone(next));
    session = next;
    options.onUpdate?.(structuredClone(session));
  }
  async function pause(reason: string) {
    await commit((next) => {
      next.pauseReason = reason;
    });
    return session;
  }
  // A complete received response is a durable local fact, even if the browser was stopped afterward.
  if (session.pendingAssistant) await commit(settlePending);
  if (session.phase !== 'translating') return session;
  if (session.retry.attempts >= 3)
    return session.pauseReason
      ? session
      : pause('当前批已达到 3 次请求上限，请显式重试。');
  if (session.pauseReason && !session.pauseReason.includes('停止'))
    return session;
  while (session.phase === 'translating') {
    if (options.signal?.aborted) return pause('用户已停止，断点已保存。');
    if (
      session.retry.attempts >= 3 ||
      (session.pauseReason && !session.pauseReason.includes('停止'))
    )
      return session;
    await commit((next) => {
      next.pauseReason = undefined;
      if (next.promptCursor !== next.cursor) {
        next.messages.push({
          role: 'user',
          content: buildDeltaBatchPrompt(next),
          timestamp: Date.now(),
        });
        next.promptCursor = next.cursor;
      }
      next.retry.attempts++;
      next.retry.totalAttempts++;
      next.requests.push({
        requestId: `${next.runId}:${next.requests.length + 1}`,
        batchId: next.batches[next.cursor].id,
        window: next.retry.window,
        attempt: next.retry.attempts,
        status: 'pending',
      });
    });
    if (options.signal?.aborted) {
      // The checkpoint reserved a request, but stop arrived before it was sent.
      await commit((next) => {
        next.requests.pop();
        next.retry.attempts--;
        next.retry.totalAttempts--;
        next.pauseReason = '用户已停止，断点已保存。';
      });
      return session;
    }
    const requestId = session.requests[session.requests.length - 1].requestId;
    let result: PiAiSessionResult;
    try {
      result = await options.transport({
        ...session.model,
        key: options.key,
        systemPrompt: session.systemPrompt,
        messages: structuredClone(session.messages),
        tools: structuredClone(session.tools),
        requestParams:
          session.retry.nextRequestParams ?? session.model.requestParams,
        signal: options.signal,
        onThinking: options.onThinking,
      });
    } catch (error) {
      const failure = error as Error & { status?: number; retryAfter?: number };
      const aborted = options.signal?.aborted || failure.name === 'AbortError';
      const retryable =
        !aborted &&
        (failure.status === undefined ||
          failure.status === 429 ||
          (failure.status >= 500 && failure.status <= 599)) &&
        !/unsupported|not supported|context.{0,20}(?:limit|long|exceed)|不支持/i.test(
          failure.message,
        );
      await commit((next) => {
        const record = next.requests.find(
          (record) => record.requestId === requestId,
        )!;
        record.status = 'error';
        record.error = failure.message;
        if (aborted) next.pauseReason = '用户已停止，断点已保存。';
        else if (!retryable) next.pauseReason = failure.message;
        else if (next.retry.attempts >= 3)
          next.pauseReason = `当前批已达到 3 次请求上限：${failure.message}`;
      });
      if (session.pauseReason) return session;
      try {
        const delay = Math.min(
          30000,
          Math.max(
            0,
            failure.retryAfter ??
              (options.retryDelayMs ?? 500) * 2 ** (session.retry.attempts - 1),
          ),
        );
        await retryWait(delay, options.signal);
      } catch {
        return pause('用户已停止，断点已保存。');
      }
      continue;
    }
    await commit((next) => {
      next.pendingAssistant = {
        requestId,
        message: result.message,
        usagePresence: result.usagePresence,
      };
      next.requests.find((record) => record.requestId === requestId)!.status =
        'received';
    });
    await commit(settlePending);
  }
  return session;
}

export function retryWait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Stopped', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    function abort() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new DOMException('Stopped', 'AbortError'));
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}
