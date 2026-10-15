<script lang="ts" setup>
import { Toast } from '@novelia/web-kit';
import {
  BookOutlined,
  DeleteOutlineOutlined,
  PlayArrowOutlined,
  PlusOutlined,
  RefreshOutlined,
  StopOutlined,
} from '@vicons/material';
import { VueDraggable } from 'vue-draggable-plus';
import {
  Semaphore,
  OpenAiTranslator,
  SakuraTranslator,
  TranslationPipeline,
} from '@auto-novel/translator';
import type {
  DeltaChapterSession,
  TranslatorTracker,
} from '@auto-novel/translator';

import { useWorkspaceStore } from '@/stores';
import { TaskExecutor } from '@/domain/translator/TaskExecutor';
import { IndexedDbSegmentCache } from '@/domain/translator/IndexedDbSegmentCache';
import { createTranslationTask } from '@/domain/translator/TranslationTask/createTranslationTask';
import type {
  TranslationTask,
  TranslatorId,
} from '@/domain/translator/TranslationTask/types';
import { TaskState } from '@/domain/translator/TaskState';
import type { ChapterStatus } from '@/domain/translator/TaskState';
import type {
  GptPipelineWorker,
  SakuraWorker,
  TranslateJob,
  TranslateJobRecord,
} from '@/model/Translator';
import { TranslateTaskDescriptor } from '@/model/Translator';
import PipelineTaskCard from './components/PipelineTaskCard.vue';
import { DeltaController } from '@/domain/translator/delta/DeltaController';
import { IndexedDbDeltaSessionStore } from '@/domain/translator/delta/IndexedDbDeltaSessionStore';
import { createDeltaTaskSource } from '@/domain/translator/delta/DeltaTaskSource';
import { syncDeltaChapterProgress } from '@/domain/translator/delta/chapter-progress';
import {
  WorkspaceExecution,
  waitForLegacyDrain,
  type WorkspaceMode,
} from '@/domain/translator/delta/WorkspaceExecution';

const props = defineProps<{ translatorId: TranslatorId }>();
const isSakura = computed(() => props.translatorId === 'sakura');
const segCacheName = isSakura.value ? 'sakura-seg-cache' : 'gpt-seg-cache';

const workerStore = useWorkspaceStore(
  isSakura.value ? 'sakura' : 'gpt-pipeline',
);
const jobStore = useWorkspaceStore(props.translatorId);

const jobs = computed(() => jobStore.ref.value.jobs);
const selectedMode = ref<WorkspaceMode>('pipeline');

interface WorkerState {
  running: boolean;
  concurrency: { current: number; max: number };
  allowUpload?: boolean;
}

// ========== 任务状态管理 ==========
const taskStates = ref(new Map<string, TaskState>());
const taskCache = new Map<string, TranslationTask>();
const taskVersions = ref(new Map<string, number>());

function syncDeltaSessionsToTasks(sessions: DeltaChapterSession[]) {
  for (const session of sessions) {
    const taskId = session.identity.taskId;
    const state = taskStates.value.get(taskId);
    const job = jobs.value.find((j) => j.task === taskId);
    if (
      !state ||
      !job ||
      (session.identity.taskCreatedAt !== undefined &&
        session.identity.taskCreatedAt !== job.createAt)
    )
      continue;
    state.chapters = syncDeltaChapterProgress(state.chapters, session);
    if (job) {
      const doneCount = state.chapters.filter(
        (c) => c.status === 'done',
      ).length;
      (job as TranslateJobRecord).progress = {
        finished: doneCount,
        error: state.chapters.filter((c) => c.status === 'error').length,
        total: state.chapters.length,
      };
    }
  }
}

const deltaSessions = shallowRef<DeltaChapterSession[]>([]);
const deltaWorkerStates = ref(new Map<string, WorkerState>());
const deltaRuns = reactive(new Map<string, Promise<void>>());
const pipelineStarts = new Map<string, Promise<void>>();
const pipelineDraining = ref(false);
const maintainingCheckpoints = ref(false);
const cancelledStarts = new Set<string>();
let closing = false;
let checkpointRefresh: Promise<void> | undefined;
const pendingStarts = reactive(new Set<string>());
const workspaceExecution = isSakura.value
  ? undefined
  : new WorkspaceExecution();
const delta = isSakura.value
  ? undefined
  : new DeltaController({
      store: new IndexedDbDeltaSessionStore(),
      source: createDeltaTaskSource,
      jobs: () => jobs.value,
      onSessions: (sessions) => {
        deltaSessions.value = sessions;
        syncDeltaSessionsToTasks(sessions);
      },
      onWorkerChange: (id, running, current, max) => {
        deltaWorkerStates.value.set(id, {
          running,
          concurrency: { current, max },
        });
      },
      onChapterChange: (taskId, chapterId, status, session) => {
        const state = taskStates.value.get(taskId);
        if (state) {
          const ch = state.chapters.find((c) => c.chapterId === chapterId);
          if (ch) {
            ch.status = session?.pauseReason
              ? session.pauseReason.includes('停止')
                ? 'pending'
                : 'paused'
              : status;
            if (session) {
              ch.segmentProgress = {
                completed:
                  session.phase === 'completed'
                    ? session.batches.length
                    : session.cursor,
                total: session.batches.length,
              };
            }
          }
          const job = jobs.value.find((j) => j.task === taskId);
          if (job) {
            const doneCount = state.chapters.filter(
              (c) => c.status === 'done',
            ).length;
            (job as TranslateJobRecord).progress = {
              finished: doneCount,
              error: state.chapters.filter((c) => c.status === 'error').length,
              total: state.chapters.length,
            };
          }
        }
      },
      onTaskDone: (taskId, total) => {
        const job = jobs.value.find((job) => job.task === taskId);
        if (job) {
          job.finishAt = Date.now();
          (job as TranslateJobRecord).progress = {
            finished: total,
            error: 0,
            total,
          };
        }
      },
    });
const deltaReady = delta?.load() ?? Promise.resolve();
void deltaReady.catch((error) => Toast.error(`Delta 检查点读取失败：${error}`));
const activeDeltaWorkers = computed(() =>
  [...deltaWorkerStates.value]
    .filter(([, state]) => state.running)
    .map(([id]) => id),
);
const activeDeltaCounts = computed(() =>
  Object.fromEntries(
    [...deltaWorkerStates.value].map(([id, state]) => [
      id,
      state.concurrency.current,
    ]),
  ),
);
const deltaBusy = computed(
  () =>
    activeDeltaWorkers.value.length > 0 ||
    deltaRuns.size > 0 ||
    pendingStarts.size > 0 ||
    maintainingCheckpoints.value,
);

const showWorkerModal = ref(false);
const showLocalVolumeDrawer = ref(false);

/** 同时处理的章节数上限 */
const GLOBAL_WINDOW = 66;
/** 同时 fetch 的章节数上限 */
const FETCH_CONCURRENCY = 1;
const fetchSemaphore = new Semaphore(FETCH_CONCURRENCY);
/** pipeline 内同时翻译的分块的高水位标记 */
const HIGH_WATER_MARK = 100;
const pipeline = new TranslationPipeline(
  HIGH_WATER_MARK,
  undefined,
  new IndexedDbSegmentCache(segCacheName),
  isSakura.value ? 'chapter' : 'segment',
);

const workerStates = ref(new Map<string, WorkerState>());
const workerErrors = computed(() => {
  const errors = new Map<string, number>();
  for (const [, state] of taskStates.value) {
    for (const [, chapterState] of state.chapterStates) {
      for (const seg of chapterState.segments) {
        if (seg.status === 'error' && seg.translatorId) {
          errors.set(seg.translatorId, (errors.get(seg.translatorId) ?? 0) + 1);
        }
      }
    }
  }
  return errors;
});
const executingTasks = reactive(new Set<string>());

let processLoopAbortController: AbortController | null = null;
let processLoopPromise: Promise<void> | null = null;

onUnmounted(() => {
  closing = true;
  void stopAllWorkers();
});
// ========== 任务过滤 ==========

type TaskFilter = 'all' | 'done' | 'pending';
const taskFilter = ref<TaskFilter>('all');

const filterOptions: { label: string; value: TaskFilter }[] = [
  { label: '全部', value: 'all' },
  { label: '已完成', value: 'done' },
  { label: '未完成', value: 'pending' },
];

function getTaskStatus(taskDesc: string): TaskFilter {
  const job = jobs.value.find((j) => j.task === taskDesc);
  return job?.finishAt ? 'done' : 'pending';
}

const filteredJobs = computed(() => {
  if (taskFilter.value === 'all') return jobs.value;
  return jobs.value.filter((j) => getTaskStatus(j.task) === taskFilter.value);
});

async function getOrCreateTask(taskDesc: string): Promise<TranslationTask> {
  let task = taskCache.get(taskDesc);
  if (!task) {
    const { desc, params } = TranslateTaskDescriptor.parse(taskDesc);
    task = createTranslationTask(desc, props.translatorId, params);
    taskCache.set(taskDesc, task);
  }
  return task;
}

function getNextJob(
  jobs: TranslateJob[],
  taskStatesMap: Map<string, TaskState>,
): { job: TranslateJob; chapterId: string; state: TaskState } | null {
  for (const job of jobs) {
    if (job.finishAt) continue;
    const state = taskStatesMap.get(job.task);
    if (!state) continue;
    for (const ch of state.chapters) {
      if (ch.status !== 'pending') continue;
      ch.status = 'translating';
      return { job, chapterId: ch.chapterId, state };
    }
  }
  return null;
}

function countPendingChapters(
  jobs: TranslateJob[],
  taskStatesMap: Map<string, TaskState>,
): number {
  let count = 0;
  for (const job of jobs) {
    if (job.finishAt) continue;
    const state = taskStatesMap.get(job.task);
    if (!state) continue;
    for (const ch of state.chapters) {
      if (ch.status === 'pending') count++;
    }
  }
  return count;
}

function hasRunningWorker(): boolean {
  return [...workerStates.value.values()].some((s) => s.running);
}

function clearTaskRuntimeState(task: string): void {
  taskStates.value.delete(task);
  taskCache.delete(task);
  taskVersions.value.delete(task);
}

// ========== 全局处理循环 ==========

function runProcessLoop(): Promise<void> | null {
  if (processLoopPromise) return processLoopPromise;
  if (!hasRunningWorker()) {
    return null;
  }

  processLoopAbortController = new AbortController();
  const signal = processLoopAbortController.signal;

  const processOne = async () => {
    while (!signal.aborted) {
      const item = getNextJob(jobs.value, taskStates.value);
      if (!item) break;

      const { job, chapterId, state } = item;
      executingTasks.add(job.task);

      const task = await getOrCreateTask(job.task);
      const executor = new TaskExecutor(task, pipeline, fetchSemaphore, () =>
        [...workerStates.value.values()].every(
          (s) => !s.running || s.allowUpload !== false,
        ),
      );

      const segmentTracker = state.getChapterState(chapterId);
      if (!segmentTracker) continue;
      await executor
        .executeChapter(
          chapterId,
          {
            onChapterStatus: (cid: string, st: ChapterStatus) => {
              state.updateStatus(cid, st);
            },
            onProgress: (finished: number, error: number, total: number) => {
              (job as TranslateJobRecord).progress = { finished, error, total };
            },
            onLog: (msg: string) => console.log(`[${job.task}] ${msg}`),
            segmentTracker,
          },
          signal,
        )
        .then(() => {
          const allDone = state.chapters.every((c) => c.status === 'done');
          const allProcessed = state.chapters.every(
            (c) => c.status === 'done' || c.status === 'error',
          );
          if (allProcessed) {
            executingTasks.delete(job.task);
          }
          if (allDone) {
            (job as TranslateJobRecord).finishAt = Date.now();
          }
        });
    }
  };

  const pendingCount = countPendingChapters(jobs.value, taskStates.value);
  const windowSize = Math.min(GLOBAL_WINDOW, pendingCount || 1);
  const workers = Array.from({ length: windowSize }, () => processOne());

  processLoopPromise = Promise.all(workers).then(() => {
    for (const t of [...executingTasks]) {
      executingTasks.delete(t);
    }
    processLoopPromise = null;
    processLoopAbortController = null;
    if (countPendingChapters(jobs.value, taskStates.value) > 0) {
      runProcessLoop();
    }
  });

  return processLoopPromise;
}

// ========== Worker 生命周期管理 ==========

const startPipelineWorker = async (workerId: string) => {
  if (workerStates.value.get(workerId)?.running) return;

  const w = workerStore.ref.value.workers.find((w) => w.id === workerId);
  if (!w) {
    Toast.error(`翻译器 ${workerId} 不存在`);
    return;
  }

  const state = reactive<WorkerState>({
    running: true,
    concurrency: { current: 0, max: w.concurrency ?? 1 },
  });
  workerStates.value.set(workerId, state);

  try {
    const t = isSakura.value
      ? await SakuraTranslator.create(w as SakuraWorker)
      : new OpenAiTranslator(w as GptPipelineWorker);

    if (workerStates.value.get(workerId) !== state || !state.running) return;

    state.allowUpload = !(t instanceof SakuraTranslator) || t.allowUpload();

    const workerTracker: TranslatorTracker = {
      onConcurrencyChange: (current: number, max: number) => {
        state.concurrency = { current, max };
      },
    };
    pipeline.registerTranslator(t, w.concurrency, workerTracker, w.id);

    runProcessLoop();
  } catch (e) {
    if (workerStates.value.get(workerId) !== state) return;
    stopPipelineWorker(workerId);
    Toast.error(`翻译器启动失败：${e}`);
  }
};

const stopPipelineWorker = (workerId: string) => {
  const state = workerStates.value.get(workerId);
  if (!state?.running) return;

  pipeline.unregisterTranslator(workerId);

  state.running = false;

  if ([...workerStates.value.values()].every((s) => !s.running)) {
    processLoopAbortController?.abort();
    processLoopAbortController = null;
    pipeline.queue.clear();
  }
};

async function acquireMode(mode: WorkspaceMode): Promise<boolean> {
  await deltaReady;
  if (closing) return false;
  if (workspaceExecution && !(await workspaceExecution.acquire(mode))) {
    Toast.warning('工作区正在另一模式或标签页运行，请停止并等待章节和提交结束');
    return false;
  }
  // A different tab may have advanced checkpoints since this page was opened.
  checkpointRefresh ??= delta?.load() ?? Promise.resolve();
  await checkpointRefresh;
  if (
    mode === 'pipeline' &&
    jobs.value.some((job) => delta?.taskHasDrafts(job.task))
  ) {
    Toast.warning('请先通过“数据管理”清除未完成的 Delta 数据，再使用默认启动');
    return false;
  }
  selectedMode.value = mode;
  return true;
}

async function releaseMode(mode: WorkspaceMode, drain: Promise<unknown>) {
  try {
    const released = await workspaceExecution?.releaseWhenIdle(
      mode,
      drain,
      () =>
        mode === 'pipeline'
          ? !hasRunningWorker()
          : !activeDeltaWorkers.value.length && deltaRuns.size === 0,
    );
    if (released) checkpointRefresh = undefined;
  } catch (error) {
    checkpointRefresh = undefined;
    throw error;
  }
}

async function startWorker(workerId: string) {
  if (workerRunning(workerId) || maintainingCheckpoints.value) return;
  const finishStart = workspaceExecution?.reserveStart();
  pendingStarts.add(workerId);
  cancelledStarts.delete(workerId);
  try {
    if (!(await acquireMode('pipeline'))) return;
    if (closing || cancelledStarts.has(workerId)) {
      return;
    }
    const starting = startPipelineWorker(workerId);
    pipelineStarts.set(workerId, starting);
    await starting;
    pipelineStarts.delete(workerId);
  } catch (error) {
    Toast.error(`翻译器启动失败：${error}`);
  } finally {
    pipelineStarts.delete(workerId);
    pendingStarts.delete(workerId);
    finishStart?.();
    if (!hasRunningWorker()) await releasePipeline();
  }
}

async function startDeltaWorker(
  workerId: string,
  retry = false,
  action?: { kind: 'skip' | 'restart'; sessionId: string },
) {
  if (
    !delta ||
    pendingStarts.has(workerId) ||
    delta.isRunning(workerId) ||
    maintainingCheckpoints.value
  )
    return;
  const finishStart = workspaceExecution?.reserveStart();
  pendingStarts.add(workerId);
  cancelledStarts.delete(workerId);
  try {
    if (!(await acquireMode('delta'))) return;
    if (closing || cancelledStarts.has(workerId)) {
      return;
    }
    const worker = workerStore.ref.value.workers.find(
      (worker) => worker.id === workerId,
    ) as GptPipelineWorker;
    if (!worker) throw new Error('找不到绑定的翻译器，请先恢复翻译器配置');
    const session =
      action && deltaSessions.value.find((s) => s.id === action.sessionId);
    const job =
      session && jobs.value.find((j) => j.task === session.identity.taskId);
    const oldFinishAt = job?.finishAt;
    const oldRunId = session?.runId;
    if (action?.kind === 'restart' && job) delete job.finishAt;
    const run = action
      ? action.kind === 'skip'
        ? delta.skipReview(action.sessionId, toRaw(worker))
        : delta.restartChapter(action.sessionId, toRaw(worker))
      : retry
        ? delta.retryWorker(toRaw(worker))
        : delta.startWorker(toRaw(worker));
    deltaRuns.set(workerId, run);
    void run
      .catch((error) => {
        if (
          action?.kind === 'restart' &&
          job &&
          oldFinishAt &&
          deltaSessions.value.find((s) => s.id === action.sessionId)?.runId ===
            oldRunId
        )
          job.finishAt = oldFinishAt;
        Toast.error(`Delta 运行失败：${error}`);
      })
      .finally(async () => {
        if (deltaRuns.get(workerId) === run) deltaRuns.delete(workerId);
        if (!activeDeltaWorkers.value.length && deltaRuns.size === 0) {
          await releaseMode('delta', Promise.resolve());
        }
      });
  } catch (error) {
    Toast.error(`Delta 启动失败：${error}`);
  } finally {
    pendingStarts.delete(workerId);
    finishStart?.();
    if (!activeDeltaWorkers.value.length && deltaRuns.size === 0)
      await releaseMode('delta', Promise.resolve());
  }
}

async function actOnDeltaChapter(sessionId: string, kind: 'skip' | 'restart') {
  const session = deltaSessions.value.find((s) => s.id === sessionId);
  if (!session) return;
  await startDeltaWorker(session.workerId, false, { kind, sessionId });
}

async function releasePipeline() {
  pipelineDraining.value = true;
  const drain = waitForLegacyDrain(
    Promise.allSettled([...pipelineStarts.values()]),
    () => processLoopPromise,
    () =>
      [...workerStates.value.values()].reduce(
        (total, state) => total + state.concurrency.current,
        0,
      ),
  );
  try {
    await releaseMode('pipeline', drain);
    await drain;
  } finally {
    pipelineDraining.value = false;
  }
}

async function stopWorker(workerId: string) {
  cancelledStarts.add(workerId);
  if (delta && (delta.isRunning(workerId) || deltaRuns.has(workerId))) {
    const stopping = delta.stopWorker(workerId);
    if (!activeDeltaWorkers.value.length) {
      await releaseMode(
        'delta',
        Promise.allSettled([stopping, ...deltaRuns.values()]),
      );
    } else {
      await stopping;
    }
  } else {
    stopPipelineWorker(workerId);
    if (!hasRunningWorker()) await releasePipeline();
  }
}

async function startAllWorkers() {
  await Promise.all(
    workerStore.ref.value.workers.map((worker) => startWorker(worker.id)),
  );
}

async function startAllDeltaWorkers() {
  await Promise.all(
    workerStore.ref.value.workers.map((worker) => startDeltaWorker(worker.id)),
  );
}

async function stopPipelineAll() {
  for (const workerId of pendingStarts) {
    if (!deltaWorkerStates.value.get(workerId)?.running) {
      cancelledStarts.add(workerId);
    }
  }
  for (const worker of workerStore.ref.value.workers) {
    stopPipelineWorker(worker.id);
  }
  await releasePipeline();
}

async function stopDeltaAll() {
  for (const workerId of pendingStarts) {
    if (deltaWorkerStates.value.get(workerId)?.running) {
      cancelledStarts.add(workerId);
    }
  }
  const stoppingDelta = delta?.stopAll() ?? Promise.resolve();
  await Promise.all([
    releaseMode(
      'delta',
      Promise.allSettled([stoppingDelta, ...deltaRuns.values()]),
    ),
    stoppingDelta,
  ]);
}

async function stopAllWorkers() {
  await Promise.all([stopPipelineAll(), stopDeltaAll()]);
}

function workerRunning(workerId: string) {
  return (
    !!workerStates.value.get(workerId)?.running ||
    !!deltaWorkerStates.value.get(workerId)?.running ||
    pendingStarts.has(workerId) ||
    !!workerStates.value.get(workerId)?.concurrency.current
  );
}
function workerConcurrency(worker: GptPipelineWorker | SakuraWorker) {
  return (
    (selectedMode.value === 'delta'
      ? deltaWorkerStates.value.get(worker.id)
      : workerStates.value.get(worker.id)
    )?.concurrency ?? {
      current: 0,
      max: worker.concurrency ?? 1,
    }
  );
}
function workerErrorCount(workerId: string) {
  return workerErrors.value.get(workerId) ?? 0;
}
function workerDeltaPausedCount(workerId: string) {
  return deltaSessions.value.filter(
    (session) =>
      session.workerId === workerId &&
      session.pauseReason &&
      !session.pauseReason.includes('停止'),
  ).length;
}
function canResumeDelta(workerId: string) {
  return deltaSessions.value.some(
    (session) => session.workerId === workerId && session.phase !== 'completed',
  );
}
async function discardDeltaScope(
  scope: { sessionId: string } | { novelId: string } | { pending: true },
) {
  if (
    !delta ||
    !workspaceExecution ||
    deltaBusy.value ||
    hasRunningWorker() ||
    pipelineDraining.value
  )
    return;
  maintainingCheckpoints.value = true;
  try {
    await Toast.promise(
      workspaceExecution
        .runMaintenance('delta', async () => {
          await deltaReady;
          await delta.load();
          const before = deltaSessions.value;
          try {
            if ('sessionId' in scope)
              await delta.discardChapter(scope.sessionId);
            else if ('novelId' in scope)
              await delta.discardNovel(scope.novelId);
            else await delta.discardPending();
            await delta.load();
          } finally {
            const remaining = new Set(deltaSessions.value.map((s) => s.id));
            for (const session of before) {
              if (remaining.has(session.id)) continue;
              const chapter = taskStates.value
                .get(session.identity.taskId)
                ?.chapters.find(
                  (ch) => ch.chapterId === session.identity.chapterId,
                );
              if (chapter) {
                chapter.segmentProgress = undefined;
                if (
                  chapter.status === 'translating' ||
                  chapter.status === 'paused'
                ) {
                  chapter.status = 'pending';
                }
              }
            }
          }
        })
        .then((maintained) => {
          if (!maintained) throw new Error('工作区忙碌');
        }),
      { success: '清除数据成功', error: '清除数据失败' },
    );
  } finally {
    checkpointRefresh = undefined;
    maintainingCheckpoints.value = false;
  }
}

async function retryDeltaWorkers() {
  const workers = [
    ...new Set(
      deltaSessions.value
        .filter((session) => session.pauseReason)
        .map((session) => session.workerId),
    ),
  ];
  if (!workers.length) Toast.info('没有需要重试的 Delta 失败章节');
  await Promise.all(
    workers.map((workerId) => startDeltaWorker(workerId, true)),
  );
}
function deltaJobProgress(job: TranslateJob) {
  const sessions = deltaSessions.value.filter(
    (session) => session.identity.taskId === job.task,
  );
  const done = sessions.filter(
    (session) => session.phase === 'completed',
  ).length;
  return `${done}/${sessions.length} 个会话完成${job.finishAt ? ' · 任务已完成' : ''}`;
}

const deleteJob = (task: string) => {
  if (
    executingTasks.has(task) ||
    delta?.hasTask(task) ||
    delta?.taskHasDrafts(task)
  ) {
    Toast.error(
      '任务正在翻译或有未完成的 Delta 数据，请先停止并在数据管理中清除',
    );
    return;
  }
  jobStore.deleteJob(task);
  clearTaskRuntimeState(task);
};

const deleteAllJobs = () =>
  filteredJobs.value.forEach((j) => deleteJob(j.task));

const taskCardRefs = ref<InstanceType<typeof PipelineTaskCard>[]>([]);
function retryTaskCards() {
  if (selectedMode.value === 'delta') return retryDeltaWorkers();
  let hasFailed = false;
  for (const card of taskCardRefs.value) {
    if (card?.hasFailedChapters?.()) {
      card.retryAllFailed();
      hasFailed = true;
    }
  }
  if (!hasFailed) {
    Toast.info('没有需要重试的失败任务');
  }
}

const clearCache = () =>
  Toast.promise(new IndexedDbSegmentCache(segCacheName).clear(), {
    success: '缓存清除成功',
    error: '缓存清除失败',
  });

watch(
  () => [...jobs.value],
  async (workspaceJobs) => {
    await deltaReady;
    const uninitialized: TranslateJob[] = [];
    const activeTasks = new Set(workspaceJobs.map((job) => job.task));
    const knownTasks = new Set([
      ...taskStates.value.keys(),
      ...taskCache.keys(),
      ...taskVersions.value.keys(),
    ]);
    for (const task of knownTasks) {
      if (!activeTasks.has(task)) clearTaskRuntimeState(task);
    }

    for (const job of workspaceJobs) {
      if (taskVersions.value.get(job.task) !== job.createAt) {
        clearTaskRuntimeState(job.task);
      }
      const state = taskStates.value.get(job.task);
      if (
        taskVersions.value.get(job.task) === job.createAt &&
        state?.initialized
      ) {
        continue;
      }
      if (job.finishAt) {
        taskStates.value.set(
          job.task,
          reactive(new TaskState(job.task)) as TaskState,
        );
        taskVersions.value.set(job.task, job.createAt);
        continue;
      }
      uninitialized.push(job);
    }
    await Promise.all(
      uninitialized.map(async (job) => {
        try {
          const task = await getOrCreateTask(job.task);
          if (!task.initialized) await task.initMeta();
          const currentJob = jobs.value.find((it) => it.task === job.task);
          if (!currentJob || currentJob.createAt !== job.createAt) return;
          const chapters = task.chapters;
          const state = reactive(new TaskState(job.task)) as TaskState;
          state.initChapters(chapters);
          taskStates.value.set(job.task, state);
          taskVersions.value.set(job.task, job.createAt);
          const doneCount = chapters.filter((c) => c.status === 'done').length;
          (job as TranslateJobRecord).progress = {
            finished: doneCount,
            error: 0,
            total: chapters.length,
          };
          if (
            !delta?.taskHasDrafts(job.task) &&
            (chapters.length === 0 || doneCount === chapters.length)
          ) {
            job.finishAt = Date.now();
          }
          syncDeltaSessionsToTasks(deltaSessions.value);
        } catch (e) {
          console.warn('任务初始化失败', job.task, e);
        }
      }),
    );
    if (uninitialized.length > 0) runProcessLoop();
  },
  { immediate: true },
);
</script>

<template>
  <div class="layout-content">
    <n-h1>{{ isSakura ? 'Sakura' : 'GPT' }}工作区BETA</n-h1>
    <bulletin>
      <n-p>
        支持并发和查看章节分块状态的新工作区。目前处于测试阶段，有问题请在群内反馈。
      </n-p>
    </bulletin>

    <section-header title="翻译器">
      <c-button
        label="添加翻译器"
        :icon="PlusOutlined"
        @action="showWorkerModal = true"
      />
    </section-header>

    <n-flex vertical style="margin-bottom: 8px">
      <n-flex
        align="center"
        justify="space-between"
        :wrap="true"
        style="gap: 12px"
      >
        <!-- 默认模式 (常规分块流水线) -->
        <c-action-wrapper title="默认" align="center">
          <n-button-group size="small">
            <c-button
              label="启动全部"
              :icon="PlayArrowOutlined"
              :round="false"
              :disabled="maintainingCheckpoints || deltaBusy"
              @action="startAllWorkers"
            />
            <c-button
              label="停止全部"
              :icon="StopOutlined"
              :round="false"
              @action="stopPipelineAll"
            />
            <c-button-confirm
              hint="真的要清空分块缓存吗？"
              label="清空缓存"
              :icon="DeleteOutlineOutlined"
              :round="false"
              @action="clearCache"
            />
          </n-button-group>
        </c-action-wrapper>

        <!-- Delta 模式 (上下文整章断点续译) -->
        <c-action-wrapper v-if="!isSakura" title="Delta" align="center">
          <n-button-group size="small">
            <c-button
              label="启动全部"
              :icon="PlayArrowOutlined"
              :round="false"
              :disabled="maintainingCheckpoints || hasRunningWorker()"
              @action="startAllDeltaWorkers"
            />
            <c-button
              label="停止全部"
              :icon="StopOutlined"
              :round="false"
              @action="stopDeltaAll"
            />
            <delta-checkpoint-manager
              :sessions="deltaSessions"
              :disabled="deltaBusy || pipelineDraining || hasRunningWorker()"
              @discard-chapter="discardDeltaScope({ sessionId: $event })"
              @discard-novel="discardDeltaScope({ novelId: $event })"
              @discard-pending="discardDeltaScope({ pending: true })"
            />
          </n-button-group>
        </c-action-wrapper>
      </n-flex>
    </n-flex>

    <n-empty
      v-if="workerStore.ref.value.workers.length === 0"
      description="没有翻译器"
    />
    <n-list v-else class="worker-list">
      <vue-draggable
        v-model="workerStore.ref.value.workers"
        :animation="150"
        handle=".drag-trigger"
        filter=".is-running"
      >
        <n-list-item
          v-for="w of workerStore.ref.value.workers"
          :key="w.id"
          :class="{ 'is-running': workerRunning(w.id) }"
        >
          <pipeline-worker-card
            :translator-id="translatorId"
            :worker="w"
            :running="workerRunning(w.id)"
            :concurrency="workerConcurrency(w)"
            :error-count="workerErrorCount(w.id)"
            :paused-count="workerDeltaPausedCount(w.id)"
            :delta-resume="canResumeDelta(w.id)"
            :start-disabled="maintainingCheckpoints"
            @start="startWorker"
            @start-delta="startDeltaWorker"
            @stop="stopWorker"
            @delete="workerStore.deleteWorker"
          />
        </n-list-item>
      </vue-draggable>
    </n-list>

    <section-header title="任务队列">
      <c-button
        label="本地书架"
        :icon="BookOutlined"
        @action="showLocalVolumeDrawer = true"
      />
    </section-header>

    <n-flex vertical>
      <c-action-wrapper title="状态">
        <c-radio-group
          v-model:value="taskFilter"
          :options="filterOptions"
          size="small"
        />
      </c-action-wrapper>
      <c-action-wrapper title="操作" align="center">
        <n-button-group size="small">
          <c-button-confirm
            hint="真的要删除筛选出的任务吗？"
            label="删除筛选任务"
            :icon="DeleteOutlineOutlined"
            :round="false"
            @action="deleteAllJobs"
          />
          <c-button
            label="重试失败任务"
            :icon="RefreshOutlined"
            :round="false"
            @action="retryTaskCards"
          />
        </n-button-group>
      </c-action-wrapper>
    </n-flex>
    <n-divider style="margin: 16px 0 8px" />
    <n-empty v-if="filteredJobs.length === 0" description="没有任务" />
    <div v-else class="task-list">
      <pipeline-task-card
        v-for="job of filteredJobs"
        ref="taskCardRefs"
        :key="job.task"
        :job="job"
        :translator-id="translatorId"
        :task-state="taskStates.get(job.task)"
        :task-cache-entry="taskCache.get(job.task)"
        :delta-sessions="deltaSessions"
        :delta-actions-disabled="
          deltaBusy ||
          pendingStarts.size > 0 ||
          pipelineDraining ||
          hasRunningWorker()
        "
        @skip-review="actOnDeltaChapter($event, 'skip')"
        @restart-delta="actOnDeltaChapter($event, 'restart')"
        @delete="deleteJob"
        @retry="
          (task: string) =>
            selectedMode === 'delta' ? retryDeltaWorkers() : runProcessLoop()
        "
        @retry-delta="retryDeltaWorkers"
        @top="
          (task: string) =>
            jobStore.topJob(
              jobs.find((j: { task: string }) => j.task === task)!,
            )
        "
        @bottom="
          (task: string) =>
            jobStore.bottomJob(
              jobs.find((j: { task: string }) => j.task === task)!,
            )
        "
      />
    </div>
  </div>

  <local-volume-list-specific-translation
    v-model:show="showLocalVolumeDrawer"
    :type="translatorId"
  />
  <sakura-worker-modal v-if="isSakura" v-model:show="showWorkerModal" />
  <gpt-pipeline-worker-modal v-else v-model:show="showWorkerModal" />
</template>

<style scoped>
.task-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
</style>
