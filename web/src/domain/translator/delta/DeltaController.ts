import {
  buildOpenAiProfileParams,
  openAiProfiles,
  createDeltaSession,
  deltaChapterKey,
  deltaFingerprint,
  runDeltaChapter,
  runDeltaReview,
  reopenDeltaReviewRetryWindow,
  normalizeDeltaReviewOptions,
  skipDeltaReview,
  reopenDeltaRetryWindow,
  createPiAiSession,
  DELTA_PROMPT_VERSION,
  type DeltaChapterSession,
  type DeltaModelSnapshot,
  type DeltaChapterIdentity,
} from '@auto-novel/translator';
import type { GptPipelineWorker, TranslateJob } from '@/model/Translator';
import type { ChapterStatus } from '../TaskState';
import type { ChapterDetail } from '../TranslationTask/types';
import type { DeltaSessionRepository, DeltaTaskSource } from './types';

interface ControllerOptions {
  store: DeltaSessionRepository;
  source: (taskDesc: string) => Promise<DeltaTaskSource>;
  jobs: () => TranslateJob[];
  onSessions?: (sessions: DeltaChapterSession[]) => void;
  onWorkerChange?: (
    id: string,
    running: boolean,
    current: number,
    max: number,
  ) => void;
  onChapterChange?: (
    taskId: string,
    chapterId: string,
    status: ChapterStatus,
    session?: DeltaChapterSession,
  ) => void;
  onTaskDone?: (taskId: string, total: number) => void;
  runChapter?: typeof runDeltaChapter;
  runReview?: typeof runDeltaReview;
}

interface WorkerRun {
  controller: AbortController;
  promise: Promise<void>;
  current: number;
  max: number;
  attempted: Set<string>;
  errors: unknown[];
}
type ChapterClaim =
  | { session: DeltaChapterSession; taskId: string; chapterId: string }
  | {
      identity: DeltaChapterIdentity;
      taskId: string;
      chapterId: string;
      title: string;
    };
const doneKey = (job: TranslateJob, chapterKey: string) =>
  JSON.stringify([chapterKey, job.task, job.createAt]);

export function deltaWorkerModel(
  worker: GptPipelineWorker,
): DeltaModelSnapshot {
  const format =
    openAiProfiles.find((p) => p.id === worker.profile?.id)?.apiFormat ??
    'openai';
  return {
    protocol: format === 'openai' ? 'openai-completions' : format,
    endpoint: worker.endpoint,
    model: worker.model,
    profile: worker.profile?.id,
    requestParams: buildOpenAiProfileParams(
      worker.profile?.id,
      worker.profile?.values,
    ),
  };
}

function translationHash(detail: ChapterDetail): string {
  return deltaFingerprint({
    paragraphs: detail.oldParagraphZh ?? null,
    glossary: sortedGlossary(detail.oldGlossary ?? {}),
  });
}
function sortedGlossary(glossary: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(glossary).sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** Owns chapter slots; every claimed chapter remains bound through upload drain. */
export class DeltaController {
  private sessions = new Map<string, DeltaChapterSession>();
  private workers = new Map<string, WorkerRun>();
  private retries = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private claimed = new Set<string>();
  private claimedTasks = new Map<string, string>();
  private sources = new Map<string, Promise<DeltaTaskSource>>();
  private done = new Set<string>();

  constructor(private options: ControllerOptions) {}

  async load(): Promise<void> {
    this.sessions = new Map(
      (await this.options.store.list()).map((s) => [s.id, s]),
    );
    this.notify();
  }
  isRunning(id: string) {
    return this.workers.has(id) || this.retries.has(id);
  }
  activeCount(id: string) {
    return this.workers.get(id)?.current ?? 0;
  }
  hasTask(taskId: string) {
    return [...this.claimedTasks.values()].includes(taskId);
  }
  hasDrafts() {
    return [...this.sessions.values()].some((s) => s.phase !== 'completed');
  }
  taskHasDrafts(taskId: string) {
    return [...this.sessions.values()].some(
      (s) =>
        s.identity.taskId.split('?')[0] === taskId.split('?')[0] &&
        s.phase !== 'completed',
    );
  }

  startWorker(worker: GptPipelineWorker): Promise<void> {
    const retry = this.retries.get(worker.id);
    if (retry) return retry.promise;
    return this.beginWorker(worker);
  }
  private beginWorker(worker: GptPipelineWorker): Promise<void> {
    const existing = this.workers.get(worker.id);
    if (existing) return existing.promise;
    const snapshot = structuredClone(worker);
    const run: WorkerRun = {
      controller: new AbortController(),
      promise: Promise.resolve(),
      current: 0,
      max: snapshot.concurrency,
      attempted: new Set(),
      errors: [],
    };
    this.workers.set(snapshot.id, run);
    this.updateWorker(snapshot.id, run);
    run.promise = Promise.allSettled(
      Array.from({ length: run.max }, () => this.slot(snapshot, run)),
    )
      .then(async (results) => {
        await this.completeTasks();
        const failed = results.find((r) => r.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
        if (run.errors.length) throw run.errors[0];
      })
      .finally(() => {
        this.workers.delete(snapshot.id);
        this.options.onWorkerChange?.(snapshot.id, false, 0, run.max);
        if (!this.workers.size) this.sources.clear();
      });
    return run.promise;
  }

  async stopWorker(id: string): Promise<void> {
    const retry = this.retries.get(id);
    retry?.controller.abort();
    const run = this.workers.get(id);
    run?.controller.abort();
    await Promise.allSettled([run?.promise, retry?.promise]);
  }
  async stopAll(): Promise<void> {
    for (const retry of this.retries.values()) retry.controller.abort();
    for (const run of this.workers.values()) run.controller.abort();
    await Promise.allSettled(
      [...this.workers.values(), ...this.retries.values()].map(
        (r) => r.promise,
      ),
    );
  }
  retryWorker(worker: GptPipelineWorker): Promise<void> {
    const existing = this.retries.get(worker.id);
    if (existing) return existing.promise;
    return this.prepareWorker(worker, async (signal) => {
      const running = this.workers.get(worker.id);
      running?.controller.abort();
      await running?.promise;
      for (const s of this.sessions.values()) {
        if (signal.aborted) return;
        if (s.workerId !== worker.id || s.phase === 'completed') continue;
        const next =
          s.phase === 'reviewing'
            ? reopenDeltaReviewRetryWindow(s)
            : s.phase === 'translating'
              ? reopenDeltaRetryWindow(s)
              : structuredClone(s);
        next.revision = s.revision + 1;
        await this.save(next);
      }
    });
  }

  private prepareWorker(
    worker: GptPipelineWorker,
    prepare: (signal: AbortSignal) => Promise<void>,
    chapter?: DeltaChapterSession,
  ): Promise<void> {
    const preparing = {
      controller: new AbortController(),
      promise: Promise.resolve(),
    };
    this.retries.set(worker.id, preparing);
    if (chapter) {
      this.claimed.add(chapter.id);
      this.claimedTasks.set(chapter.id, chapter.identity.taskId);
    }
    this.options.onWorkerChange?.(
      worker.id,
      true,
      this.activeCount(worker.id),
      worker.concurrency,
    );
    preparing.promise = (async () => {
      try {
        await prepare(preparing.controller.signal);
      } finally {
        if (chapter) {
          this.claimed.delete(chapter.id);
          this.claimedTasks.delete(chapter.id);
        }
      }
      if (!preparing.controller.signal.aborted) await this.beginWorker(worker);
    })().finally(() => {
      this.retries.delete(worker.id);
      if (!this.workers.has(worker.id))
        this.options.onWorkerChange?.(worker.id, false, 0, worker.concurrency);
    });
    return preparing.promise;
  }
  async clear(): Promise<void> {
    await this.stopAll();
    await this.options.store.clear();
    this.sessions.clear();
    this.done.clear();
    this.notify();
  }

  discardChapter(sessionId: string): Promise<void> {
    return this.discard((session) => session.id === sessionId);
  }

  discardNovel(novelId: string): Promise<void> {
    return this.discard((session) => session.identity.novelId === novelId);
  }

  async skipReview(
    sessionId: string,
    worker: GptPipelineWorker,
  ): Promise<void> {
    if (this.isRunning(worker.id) || this.claimed.has(sessionId))
      throw new Error('请先停止该工作，再跳过审校');
    const session = this.sessions.get(sessionId);
    if (!session || session.workerId !== worker.id)
      throw new Error('审校断点或绑定工作不存在');
    await this.prepareWorker(
      worker,
      async (signal) => {
        await this.validate(
          session,
          worker,
          await this.source(session.identity.taskId),
        );
        if (signal.aborted) return;
        const next = skipDeltaReview(session);
        next.revision = session.revision + 1;
        await this.save(next);
      },
      session,
    );
  }

  async restartChapter(
    sessionId: string,
    worker: GptPipelineWorker,
  ): Promise<void> {
    if (this.isRunning(worker.id) || this.claimed.has(sessionId))
      throw new Error('请先停止该工作，再重新翻译');
    const previous = this.sessions.get(sessionId);
    if (!previous || previous.workerId !== worker.id)
      throw new Error('章节断点或绑定工作不存在');
    await this.prepareWorker(
      worker,
      async (signal) => {
        const src = await this.source(previous.identity.taskId);
        const current = await src.readChapter(previous.identity.chapterId);
        if (signal.aborted) return;
        const session = createDeltaSession({
          runId: crypto.randomUUID(),
          workerId: worker.id,
          identity: {
            ...previous.identity,
            taskCreatedAt:
              this.options
                .jobs()
                .find((job) => job.task === previous.identity.taskId)
                ?.createAt ?? previous.identity.taskCreatedAt,
          },
          source: current.paragraphs,
          glossary: current.glossary,
          glossaryId: current.glossaryId,
          metadata: {
            ...src.metadata,
            chapterTitle: previous.metadata.chapterTitle,
          },
          model: deltaWorkerModel(worker),
          previousTranslationHash: translationHash(current),
          reviewOptions: normalizeDeltaReviewOptions(worker.deltaReview),
        });
        session.revision = previous.revision + 1;
        await this.save(session);
        for (const key of this.done) {
          if (JSON.parse(key)[0] === sessionId) this.done.delete(key);
        }
      },
      previous,
    );
  }

  private async discard(
    matches: (session: DeltaChapterSession) => boolean,
  ): Promise<void> {
    if (this.workers.size || this.retries.size)
      throw new Error('Delta 正在运行');
    try {
      for (const session of this.sessions.values()) {
        if (!matches(session)) continue;
        await this.options.store.delete(session.id);
        this.sessions.delete(session.id);
        for (const key of this.done) {
          if (JSON.parse(key)[0] === session.id) this.done.delete(key);
        }
        if (session.phase !== 'completed')
          this.options.onChapterChange?.(
            session.identity.taskId,
            session.identity.chapterId,
            'pending',
          );
      }
    } finally {
      this.notify();
    }
  }

  private source(taskId: string) {
    const generation = this.options
      .jobs()
      .find((job) => job.task === taskId)?.createAt;
    const key = JSON.stringify([taskId, generation]);
    let pending = this.sources.get(key);
    if (!pending) {
      pending = this.options.source(taskId);
      this.sources.set(key, pending);
      pending.catch(() => this.sources.delete(key));
    }
    return pending;
  }
  private notify() {
    this.options.onSessions?.(structuredClone([...this.sessions.values()]));
  }
  private updateWorker(id: string, run: WorkerRun) {
    this.options.onWorkerChange?.(id, true, run.current, run.max);
  }
  private async save(session: DeltaChapterSession) {
    await this.options.store.save(session);
    this.sessions.set(session.id, structuredClone(session));
    this.notify();
  }
  private async patch(
    session: DeltaChapterSession,
    changes: Partial<DeltaChapterSession>,
  ) {
    const next = { ...session, ...changes, revision: session.revision + 1 };
    await this.save(next);
    return next;
  }

  private async claim(
    worker: GptPipelineWorker,
    run: WorkerRun,
  ): Promise<ChapterClaim | undefined> {
    // Reservation happens synchronously before any chapter content is read.
    for (const session of this.sessions.values()) {
      if (
        session.workerId !== worker.id ||
        session.phase === 'completed' ||
        run.attempted.has(session.id) ||
        this.claimed.has(session.id)
      )
        continue;
      this.claimed.add(session.id);
      run.attempted.add(session.id);
      return {
        session,
        taskId: session.identity.taskId,
        chapterId: session.identity.chapterId,
      };
    }
    for (const job of this.options.jobs()) {
      if (job.finishAt) continue;
      let src: DeltaTaskSource;
      try {
        src = await this.source(job.task);
      } catch (error) {
        run.errors.push(error);
        continue;
      }
      if (run.controller.signal.aborted) return;
      for (const chapter of src.chapters) {
        if (chapter.status === 'done') continue;
        const identity = {
          taskId: job.task,
          taskCreatedAt: job.createAt,
          novelId: src.novelId,
          volumeId: src.volumeId,
          chapterId: chapter.chapterId,
          title: chapter.title,
        };
        const id = deltaChapterKey(identity);
        const saved = this.sessions.get(id);
        if (
          this.claimed.has(id) ||
          run.attempted.has(id) ||
          this.done.has(doneKey(job, id)) ||
          (saved && saved.phase !== 'completed')
        )
          continue;
        if (
          saved?.phase === 'completed' &&
          saved.identity.taskId === job.task &&
          saved.identity.taskCreatedAt === job.createAt
        ) {
          this.done.add(doneKey(job, id));
          continue;
        }
        this.claimed.add(id);
        run.attempted.add(id);
        return {
          identity,
          taskId: job.task,
          chapterId: chapter.chapterId,
          title: chapter.title,
        };
      }
    }
  }

  private async slot(worker: GptPipelineWorker, run: WorkerRun) {
    while (!run.controller.signal.aborted) {
      const item = await this.claim(worker, run);
      if (!item) break;
      const id =
        'session' in item ? item.session.id : deltaChapterKey(item.identity);
      this.claimedTasks.set(id, item.taskId);
      run.current++;
      this.updateWorker(worker.id, run);
      this.options.onChapterChange?.(
        item.taskId,
        item.chapterId,
        'translating',
      );
      try {
        const src = await this.source(item.taskId);
        let session: DeltaChapterSession;
        if ('session' in item) session = item.session;
        else {
          const current = await src.readChapter(item.chapterId);
          session = createDeltaSession({
            runId: crypto.randomUUID(),
            workerId: worker.id,
            identity: item.identity,
            source: current.paragraphs,
            glossary: current.glossary,
            glossaryId: current.glossaryId,
            metadata: { ...src.metadata, chapterTitle: item.title },
            model: deltaWorkerModel(worker),
            previousTranslationHash: translationHash(current),
            reviewOptions: normalizeDeltaReviewOptions(worker.deltaReview),
          });
          const old = this.sessions.get(session.id);
          if (old) session.revision = old.revision + 1;
          await this.save(session);
        }
        await this.execute(
          session,
          worker,
          src,
          run.controller.signal,
          !('session' in item),
        );
      } catch (error) {
        // A failed transaction must not be replaced by stale in-memory progress.
        const saved = await this.options.store.get(id);
        if (saved) {
          this.sessions.set(id, saved);
          await this.patch(saved, { pauseReason: String(error) });
        } else run.errors.push(error);
        this.options.onChapterChange?.(
          item.taskId,
          item.chapterId,
          saved?.pauseReason?.includes('停止')
            ? 'pending'
            : saved
              ? 'paused'
              : 'error',
          saved,
        );
      } finally {
        this.claimed.delete(id);
        this.claimedTasks.delete(id);
        run.current--;
        this.updateWorker(worker.id, run);
      }
    }
  }

  private async validate(
    session: DeltaChapterSession,
    worker: GptPipelineWorker,
    src: DeltaTaskSource,
  ) {
    const current = await src.readChapter(session.identity.chapterId);
    if (
      session.schemaVersion !== 1 ||
      (session.promptVersion !== DELTA_PROMPT_VERSION &&
        !(
          session.promptVersion === 3 && session.reviewOptions === undefined
        )) ||
      deltaFingerprint(deltaWorkerModel(worker)) !==
        deltaFingerprint(session.model)
    )
      throw new Error('模型、协议或提示配置已变化，请保留草稿或放弃后重新启动');
    if (
      session.reviewOptions !== undefined &&
      deltaFingerprint(normalizeDeltaReviewOptions(session.reviewOptions)) !==
        deltaFingerprint(normalizeDeltaReviewOptions(worker.deltaReview))
    )
      throw new Error('审校配置已变化，请保留草稿或放弃后重新启动');
    if (
      deltaFingerprint(current.paragraphs) !== session.sourceHash ||
      current.glossaryId !== session.glossaryId ||
      deltaFingerprint(sortedGlossary(current.glossary)) !==
        deltaFingerprint(sortedGlossary(session.glossary))
    )
      throw new Error('原文或术语已变化，请放弃断点后重新启动');
    return current;
  }

  private async execute(
    session: DeltaChapterSession,
    worker: GptPipelineWorker,
    src: DeltaTaskSource,
    signal: AbortSignal,
    fresh = false,
  ) {
    if (session.phase === 'translating') {
      if (!fresh) await this.validate(session, worker, src);
      if (signal.aborted) {
        await this.patch(session, { pauseReason: '用户停止' });
        return;
      }
      session = await (this.options.runChapter ?? runDeltaChapter)(session, {
        store: { save: async (s) => this.save(s) },
        transport: createPiAiSession,
        key: worker.key,
        signal,
      });
      if (session.pauseReason) {
        if (
          this.sessions.get(session.id)?.revision !== session.revision ||
          this.sessions.get(session.id)?.pauseReason !== session.pauseReason
        )
          await this.patch(session, { pauseReason: session.pauseReason });
        this.options.onChapterChange?.(
          session.identity.taskId,
          session.identity.chapterId,
          signal.aborted || session.pauseReason.includes('停止')
            ? 'pending'
            : 'paused',
          session,
        );
        return;
      }
      // A custom runner and the normal runner share the same pre-submit boundary.
      if (this.sessions.get(session.id)?.revision !== session.revision)
        await this.save(session);
    }
    if (
      session.phase === 'readyToSubmit' &&
      session.reviewOptions?.enabled &&
      !session.review?.completed &&
      !session.review?.skipped
    )
      session = await this.patch(session, { phase: 'reviewing' });
    if (session.phase === 'reviewing') {
      await this.validate(session, worker, src);
      if (signal.aborted) {
        await this.patch(session, { pauseReason: '用户停止' });
        return;
      }
      session = await (this.options.runReview ?? runDeltaReview)(session, {
        store: { save: async (s) => this.save(s) },
        transport: createPiAiSession,
        key: worker.key,
        signal,
        readContext: (offset, contextSignal) =>
          src.readChapterContext(
            session.identity.chapterId,
            offset,
            contextSignal,
          ),
      });
      if (this.sessions.get(session.id)?.revision !== session.revision)
        await this.save(session);
      if (session.pauseReason || session.phase !== 'readyToSubmit') {
        this.options.onChapterChange?.(
          session.identity.taskId,
          session.identity.chapterId,
          signal.aborted || session.pauseReason?.includes('停止')
            ? 'pending'
            : 'paused',
          session,
        );
        return;
      }
    }
    if (signal.aborted && session.phase !== 'submitting') {
      await this.patch(session, { pauseReason: '用户停止' });
      return;
    }
    const current = await this.validate(session, worker, src);
    const final = session.finalParagraphs!;
    const finalFingerprint = deltaFingerprint({
      paragraphs: final,
      glossary: sortedGlossary(session.glossary),
    });
    const currentFingerprint = translationHash(current);
    if (currentFingerprint === finalFingerprint) {
      await this.finish(session);
      return;
    }
    if (currentFingerprint !== session.previousTranslationHash)
      throw new Error('既有译文已变化，已暂停以保留新的译文');
    signal.throwIfAborted();
    session = await this.patch(session, {
      phase: 'submitting',
      pauseReason: undefined,
    });
    // Once sent, upload drains even if this worker is stopped. An ambiguous result
    // stays submitting and is read back before any later retry.
    await src.uploadChapter(
      session.identity.chapterId,
      session.glossaryId,
      final,
    );
    await this.finish(session);
  }

  private async finish(session: DeltaChapterSession) {
    const completed = await this.patch(session, {
      phase: 'completed',
      pauseReason: undefined,
    });
    for (const job of this.options.jobs()) {
      if (
        job.task === session.identity.taskId &&
        session.identity.taskCreatedAt !== undefined &&
        job.createAt !== session.identity.taskCreatedAt
      )
        continue;
      let src: DeltaTaskSource;
      try {
        src = await this.source(job.task);
      } catch {
        continue;
      }
      if (
        src.novelId === session.identity.novelId &&
        src.volumeId === session.identity.volumeId
      )
        this.done.add(doneKey(job, session.id));
    }
    this.options.onChapterChange?.(
      session.identity.taskId,
      session.identity.chapterId,
      'done',
      completed,
    );
  }
  private async completeTasks() {
    let failure: unknown;
    for (const job of this.options.jobs()) {
      if (job.finishAt || this.taskHasDrafts(job.task)) continue;
      let src: DeltaTaskSource;
      try {
        src = await this.source(job.task);
      } catch (error) {
        failure ??= error;
        continue;
      }
      if (
        src.chapters.every(
          (c) =>
            c.status === 'done' ||
            this.done.has(
              doneKey(
                job,
                deltaChapterKey({
                  taskId: job.task,
                  novelId: src.novelId,
                  volumeId: src.volumeId,
                  chapterId: c.chapterId,
                }),
              ),
            ),
        )
      ) {
        const chapterIds = new Set(
          src.chapters.map((chapter) => chapter.chapterId),
        );
        for (const session of this.sessions.values()) {
          if (
            session.identity.taskId === job.task &&
            session.identity.taskCreatedAt === job.createAt
          )
            chapterIds.add(session.identity.chapterId);
        }
        this.options.onTaskDone?.(job.task, chapterIds.size);
      }
    }
    if (failure) throw failure;
  }
}
