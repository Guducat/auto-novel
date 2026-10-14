<script lang="ts" setup>
import { Toast } from '@novelia/web-kit';
import {
  ChevronRightOutlined,
  KeyboardDoubleArrowUpOutlined,
  KeyboardDoubleArrowDownOutlined,
  RefreshOutlined,
  DeleteOutlineOutlined,
} from '@vicons/material';
import type { ChapterMeta } from '@/domain/translator/TaskState';
import { TaskState, ChapterSegmentState } from '@/domain/translator/TaskState';
import type { TranslateJob, TranslateJobRecord } from '@/model/Translator';
import { TranslateTaskDescriptor } from '@/model/Translator';
import { createTranslationTask } from '@/domain/translator/TranslationTask/createTranslationTask';
import type {
  TranslationTask,
  TranslatorId,
} from '@/domain/translator/TranslationTask/types';
import type { DeltaChapterSession } from '@auto-novel/translator';

const props = defineProps<{
  job: TranslateJob;
  translatorId: TranslatorId;
  taskState?: TaskState;
  taskCacheEntry?: TranslationTask;
  deltaSessions?: DeltaChapterSession[];
}>();

const emit = defineEmits<{
  delete: [task: string];
  top: [task: string];
  bottom: [task: string];
  retry: [task: string];
  retryDelta: [task: string];
}>();

const taskDeltaSessions = computed(() => {
  return (props.deltaSessions ?? []).filter(
    (s) => s.identity.taskId === props.job.task,
  );
});

const hasDelta = computed(() => taskDeltaSessions.value.length > 0);

const deltaActiveCount = computed(
  () =>
    taskDeltaSessions.value.filter(
      (s) =>
        s.phase === 'translating' ||
        s.phase === 'submitting' ||
        s.phase === 'readyToSubmit',
    ).length,
);

const deltaCompletedCount = computed(
  () => taskDeltaSessions.value.filter((s) => s.phase === 'completed').length,
);

const deltaPausedCount = computed(
  () => taskDeltaSessions.value.filter((s) => !!s.pauseReason).length,
);

const deltaTotalCacheRead = computed(() => {
  return taskDeltaSessions.value
    .flatMap((s) => s.requests)
    .reduce((sum, r) => sum + (r.usage?.cacheRead ?? 0), 0);
});

const deltaTotalOutput = computed(() => {
  return taskDeltaSessions.value
    .flatMap((s) => s.requests)
    .reduce((sum, r) => sum + (r.usage?.output ?? 0), 0);
});

const jobRecord = computed(() => props.job as TranslateJobRecord);
const chapterMetas = computed(() => props.taskState?.chapters ?? []);
async function getChapterMetas(): Promise<ChapterMeta[]> {
  if (props.taskState?.initialized) return chapterMetas.value;

  let task = props.taskCacheEntry;
  if (!task) {
    task = createTask(props.job.task);
  }
  if (!task.initialized) {
    await task.initMeta();
  }
  return task.chapters;
}

function getOrCreateTaskState(): TaskState {
  if (props.taskState) return props.taskState;
  return reactive(new TaskState(props.job.task)) as TaskState;
}

const expanded = ref(false);

const toggleExpand = async () => {
  if (expanded.value) {
    expanded.value = false;
    return;
  }

  const state = getOrCreateTaskState();
  if (!state.initialized) {
    const chapters = await getChapterMetas();
    state.initChapters(chapters);
  }
  expanded.value = true;
};

const themeVars = useThemeVars();

const taskStatus = computed<'done' | 'executing' | 'pending'>(() => {
  if (props.job.finishAt) return 'done';
  if (!chapterMetas.value.length) return 'done';
  if (chapterMetas.value.some((c) => c.status === 'translating'))
    return 'executing';
  return 'pending';
});

function retryAllFailed() {
  for (const ch of chapterMetas.value) {
    if (ch.status === 'error') {
      ch.status = 'pending';
      props.taskState?.chapterStates.delete(ch.chapterId);
    }
  }
  delete props.job.finishAt;
  emit('retry', props.job.task);
}

function hasFailedChapters(): boolean {
  return (
    chapterMetas.value.some((c) => c.status === 'error') ||
    deltaPausedCount.value > 0
  );
}

defineExpose({ retryAllFailed, hasFailedChapters });

import ChapterPreviewModal from './ChapterPreviewModal.vue';
import DeltaPreviewModal from './DeltaPreviewModal.vue';

function createTask(taskDesc: string): TranslationTask {
  const { desc, params } = TranslateTaskDescriptor.parse(taskDesc);
  return createTranslationTask(desc, props.translatorId, params);
}

const totalChaptersCount = computed(
  () => chapterMetas.value.length || 0,
);

const showDeltaPreview = ref(false);
const showPipelinePreview = ref(false);
const previewTitle = ref('');
const previewChapterId = ref<string | null>(null);
const pipelineChapterState = ref<ChapterSegmentState | null>(null);

const activeDeltaSession = computed(() => {
  if (!previewChapterId.value) return null;
  return (
    taskDeltaSessions.value.find(
      (s) => s.identity.chapterId === previewChapterId.value,
    ) ?? null
  );
});

const openPreview = async (chapterId: string) => {
  try {
    previewChapterId.value = chapterId;
    const chapters = await getChapterMetas();
    const meta = chapters.find((c) => c.chapterId === chapterId);
    previewTitle.value = meta?.title ?? chapterId;

    if (activeDeltaSession.value) {
      showDeltaPreview.value = true;
      return;
    }

    const chapterState = props.taskState?.chapterStates.get(chapterId);

    let chapterStateForPreview: ChapterSegmentState | null = null;
    if (chapterState?.ready) {
      chapterStateForPreview = chapterState;
    } else {
      let previewTask = props.taskCacheEntry;
      if (!previewTask) {
        previewTask = createTask(props.job.task);
      }
      if (!previewTask.initialized) {
        await previewTask.initMeta();
      }
      const detail = await previewTask.fetchChapter(chapterId);

      if (chapterState?.ready) {
        chapterStateForPreview = chapterState;
      } else if (props.taskState?.getStatus(chapterId) === 'done') {
        const tlParagraphs = detail.oldParagraphZh;
        if (tlParagraphs?.length) {
          const loadedState = new ChapterSegmentState(chapterId);
          loadedState.injectDoneTranslation(detail.paragraphs, tlParagraphs);
          chapterStateForPreview = loadedState;
        }
      } else {
        chapterStateForPreview = chapterState ?? null;
      }
    }

    pipelineChapterState.value = chapterStateForPreview;
    showPipelinePreview.value = true;
  } catch (e) {
    console.error('加载预览失败', e);
    Toast.error('加载预览失败');
  }
};
</script>

<template>
  <n-card
    size="small"
    :hoverable="true"
    :class="{ 'task-card--expanded': expanded }"
    :header-style="{
      cursor: 'pointer',
      padding: '10px 14px',
      'user-select': 'none',
    }"
    :content-style="
      expanded ? { padding: '0 14px 10px 14px' } : { padding: '0' }
    "
  >
    <template #header>
      <div @click="toggleExpand">
        <n-flex align="center" :wrap="false" style="flex: 1; min-width: 0">
          <div style="flex: 1; min-width: 0">
            <div class="task-name">{{ job.description }}</div>
            <job-task-link :task="job.task" class="task-link" />
          </div>
          <n-flex :size="6" align="center" :wrap="false" style="flex-shrink: 0">
            <n-tag
              v-if="hasDelta"
              size="tiny"
              :bordered="false"
              :type="deltaActiveCount > 0 ? 'info' : 'primary'"
              class="delta-badge"
            >
              Delta{{ deltaActiveCount > 0 ? ` · ${deltaActiveCount} 进行中` : '' }}
            </n-tag>
            <n-tag v-if="taskStatus === 'executing'" size="tiny" type="info">
              翻译中
            </n-tag>
            <n-tag v-else-if="taskStatus === 'done'" size="tiny" type="success">
              已完成
            </n-tag>
            <n-tag v-else size="tiny" type="default">等待中</n-tag>
            <span class="task-progress">
              {{ jobRecord.progress?.finished ?? 0 }}/{{
                jobRecord.progress?.total ?? chapterMetas.length ?? 0
              }}
            </span>
          </n-flex>

          <n-flex :size="4" :wrap="false" style="flex-shrink: 0">
            <n-tooltip trigger="hover">
              <template #trigger>
                <n-button
                  size="tiny"
                  circle
                  quaternary
                  @click.stop="emit('top', job.task)"
                >
                  <template #icon>
                    <n-icon :component="KeyboardDoubleArrowUpOutlined" />
                  </template>
                </n-button>
              </template>
              置顶
            </n-tooltip>
            <n-tooltip trigger="hover">
              <template #trigger>
                <n-button
                  size="tiny"
                  circle
                  quaternary
                  @click.stop="emit('bottom', job.task)"
                >
                  <template #icon>
                    <n-icon :component="KeyboardDoubleArrowDownOutlined" />
                  </template>
                </n-button>
              </template>
              置底
            </n-tooltip>
            <n-tooltip v-if="hasFailedChapters()" trigger="hover">
              <template #trigger>
                <n-button
                  size="tiny"
                  circle
                  quaternary
                  type="warning"
                  @click.stop="retryAllFailed()"
                >
                  <template #icon>
                    <n-icon :component="RefreshOutlined" />
                  </template>
                </n-button>
              </template>
              重试失败
            </n-tooltip>
            <n-tooltip trigger="hover">
              <template #trigger>
                <n-button
                  size="tiny"
                  circle
                  quaternary
                  type="error"
                  @click.stop="emit('delete', job.task)"
                >
                  <template #icon>
                    <n-icon :component="DeleteOutlineOutlined" />
                  </template>
                </n-button>
              </template>
              删除
            </n-tooltip>
          </n-flex>

          <n-icon
            :component="ChevronRightOutlined"
            :class="['expand-arrow', { 'expand-arrow--rotated': expanded }]"
          />
        </n-flex>
      </div>
    </template>

    <div v-if="expanded && chapterMetas.length">
      <!-- Delta 状态摘要条 -->
      <div v-if="hasDelta" class="delta-card-strip">
        <n-flex align="center" justify="space-between" :wrap="false">
          <n-flex align="center" :size="6">
            <span class="delta-strip-label">Delta 进度:</span>
            <n-tag size="tiny" :bordered="false" type="success">
              完成 {{ deltaCompletedCount }}/{{ totalChaptersCount }}
            </n-tag>
            <n-tag
              v-if="deltaActiveCount"
              size="tiny"
              :bordered="false"
              type="info"
            >
              进行中 {{ deltaActiveCount }}
            </n-tag>
            <n-tag
              v-if="deltaPausedCount"
              size="tiny"
              :bordered="false"
              type="warning"
            >
              暂停 {{ deltaPausedCount }}
            </n-tag>
          </n-flex>
          <n-flex align="center" :size="6">
            <n-text depth="3" class="delta-strip-metric">
              读取缓存: {{ deltaTotalCacheRead.toLocaleString() }} · 输出: {{ deltaTotalOutput.toLocaleString() }}
            </n-text>
            <c-button
              v-if="deltaPausedCount"
              label="重试失败"
              size="tiny"
              secondary
              type="warning"
              @action="emit('retryDelta', job.task)"
            />
          </n-flex>
        </n-flex>
      </div>

      <chapter-grid
        :task-state="taskState"
        @preview="(cid: string) => openPreview(cid)"
      />
    </div>
  </n-card>

  <delta-preview-modal
    :show="showDeltaPreview"
    :title="previewTitle"
    :session="activeDeltaSession"
    @update:show="(v: boolean) => (showDeltaPreview = v)"
  />

  <chapter-preview-modal
    :show="showPipelinePreview"
    :title="previewTitle"
    :chapter-state="pipelineChapterState"
    @update:show="(v: boolean) => (showPipelinePreview = v)"
  />
</template>

<style scoped>
.task-card--expanded {
  --n-border-color: v-bind('themeVars.primaryColorHover');
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.07);
}
.task-name {
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-link {
  font-size: 11px;
  line-height: 1.2;
}
.delta-badge {
  font-weight: 500;
  letter-spacing: 0.3px;
}
.delta-card-strip {
  margin-bottom: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  background: rgba(128, 128, 128, 0.06);
}
.delta-strip-label {
  font-size: 11px;
  font-weight: 500;
  opacity: 0.8;
}
.delta-strip-metric {
  font-size: 11px;
}
.task-progress {
  font-size: 12px;
  color: v-bind('themeVars.textColor3');
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.expand-arrow {
  font-size: 14px;
  color: v-bind('themeVars.textColor3');
  margin-left: 2px;
  transition: transform 0.2s ease;
}
.expand-arrow--rotated {
  transform: rotate(90deg);
}
</style>
