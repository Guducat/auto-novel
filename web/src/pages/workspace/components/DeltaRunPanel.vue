<script lang="ts" setup>
import type {
  DeltaChapterSession,
  DeltaUsagePresence,
} from '@auto-novel/translator';

const props = defineProps<{
  sessions: DeltaChapterSession[];
  activeWorkers: string[];
  activeCounts: Record<string, number>;
  disabled?: boolean;
}>();
const emit = defineEmits<{ retry: [workerId: string] }>();
const phases = {
  translating: '翻译中',
  readyToSubmit: '待提交',
  submitting: '提交中',
  completed: '已完成',
};
const metrics: { key: keyof DeltaUsagePresence; label: string }[] = [
  { key: 'input', label: '未缓存输入' },
  { key: 'output', label: '输出' },
  { key: 'cacheRead', label: '缓存读取' },
  { key: 'cacheWrite', label: '缓存写入' },
];
const workers = computed(() => [
  ...new Set(props.sessions.map((session) => session.workerId)),
]);
const workerSessions = (workerId: string) =>
  props.sessions.filter((session) => session.workerId === workerId);
function usage(sessions: DeltaChapterSession[], key: keyof DeltaUsagePresence) {
  const requests = [
    ...new Map(
      sessions
        .flatMap((session) => session.requests)
        .map((request) => [request.requestId, request]),
    ).values(),
  ];
  const reported = requests.filter(
    (request) => request.usagePresence?.[key] && request.usage,
  );
  return reported.length
    ? `${reported.reduce((sum, request) => sum + request.usage![key], 0).toLocaleString()}（覆盖 ${reported.length}/${requests.length} 请求）`
    : `未返回（覆盖 0/${requests.length} 请求）`;
}
function thinking(session: DeltaChapterSession) {
  return session.messages
    .flatMap((message) =>
      message.role === 'assistant'
        ? message.content.flatMap((block) =>
            block.type === 'thinking' && block.thinking ? [block.thinking] : [],
          )
        : [],
    )
    .join('\n\n');
}
function completedParagraphs(session: DeltaChapterSession) {
  return session.paragraphs.filter(
    (paragraph) => paragraph.empty || paragraph.id in session.translations,
  ).length;
}
function requestStatus(session: DeltaChapterSession) {
  const request = session.requests.at(-1);
  if (!request) return '尚未发出请求';
  const status = {
    pending: '请求中',
    received: '已收到回复',
    accepted: '已接受',
    rejected: '格式修复',
    error: '请求失败',
  }[request.status];
  return `${request.batchId} · ${status} · 第 ${request.attempt}/3 次（窗口 ${request.window}，累计 ${session.retry.totalAttempts} 次）`;
}
</script>

<template>
  <n-card size="small" title="Delta 章级会话">
    <n-text depth="3">
      检查点保存在当前浏览器，重新打开后点击继续；全章初译完成后提交，本轮不执行二校。
    </n-text>
    <n-empty
      v-if="sessions.length === 0"
      description="尚无 Delta 检查点"
      style="margin-top: 12px"
    />
    <n-flex v-else vertical style="margin-top: 12px">
      <n-card
        v-for="workerId of workers"
        :key="workerId"
        size="small"
        :title="workerId"
      >
        <template #header-extra>
          <n-flex align="center" :size="8">
            <n-text depth="3">
              活动章节
              {{ activeCounts[workerId] ?? 0 }}
            </n-text>
            <c-button
              v-if="
                workerSessions(workerId).some((session) => session.pauseReason)
              "
              label="重试失败（Delta）"
              size="tiny"
              :disabled="disabled || activeWorkers.includes(workerId)"
              @action="emit('retry', workerId)"
            />
          </n-flex>
        </template>
        <n-flex :size="8" style="margin-bottom: 10px">
          <n-text
            v-for="metric of metrics"
            :key="metric.key"
            depth="3"
            style="font-size: 12px"
          >
            已报告累计 {{ metric.label }}：{{
              usage(workerSessions(workerId), metric.key)
            }}
          </n-text>
        </n-flex>
        <n-collapse>
          <n-collapse-item
            v-for="session of workerSessions(workerId)"
            :key="session.id"
            :name="session.id"
          >
            <template #header>
              {{ session.metadata.title }} ·
              {{ session.metadata.chapterTitle || session.identity.chapterId }}
            </template>
            <template #header-extra>
              <n-tag
                size="small"
                :type="
                  session.pauseReason
                    ? 'warning'
                    : session.phase === 'completed'
                      ? 'success'
                      : 'info'
                "
              >
                {{ session.pauseReason ? '已暂停' : phases[session.phase] }} ·
                {{ session.cursor }}/{{ session.batches.length }} 批
              </n-tag>
            </template>
            <n-flex vertical :size="8">
              <n-text>
                段落 {{ completedParagraphs(session) }}/{{
                  session.paragraphs.length
                }}
                · {{ requestStatus(session) }}
              </n-text>
              <n-text depth="3" style="font-size: 12px">
                {{ session.model.protocol }} · {{ session.model.model }} ·
                {{ session.model.endpoint }}
              </n-text>
              <n-alert
                v-if="session.pauseReason"
                type="warning"
                :show-icon="false"
              >
                {{ session.pauseReason }}
              </n-alert>
              <n-text
                v-for="metric of metrics"
                :key="metric.key"
                depth="3"
                style="font-size: 12px"
              >
                已报告 {{ metric.label }}：{{ usage([session], metric.key) }}
              </n-text>
              <n-collapse v-if="thinking(session)">
                <n-collapse-item
                  title="供应商返回的思考 / 摘要"
                  name="thinking"
                >
                  <n-text
                    style="white-space: pre-wrap; overflow-wrap: anywhere"
                  >
                    {{ thinking(session) }}
                  </n-text>
                </n-collapse-item>
              </n-collapse>
            </n-flex>
          </n-collapse-item>
        </n-collapse>
      </n-card>
    </n-flex>
  </n-card>
</template>
