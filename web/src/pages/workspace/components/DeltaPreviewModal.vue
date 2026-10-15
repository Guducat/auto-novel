<script lang="ts" setup>
import type {
  DeltaChapterSession,
  DeltaUsagePresence,
} from '@auto-novel/translator';

const themeVars = useThemeVars();

const props = defineProps<{
  show: boolean;
  title: string;
  session: DeltaChapterSession | null;
  actionsDisabled?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:show', val: boolean): void;
  (e: 'skipReview', sessionId: string): void;
  (e: 'restartDelta', sessionId: string): void;
}>();

// -1 = 全章, 0..N-1 = 具体批次
const selectedBatchIndex = ref(-1);
const visibleBatch = computed(() => {
  const s = props.session;
  return s?.batches[
    selectedBatchIndex.value < 0 ? s.cursor : selectedBatchIndex.value
  ];
});
const includesBatchHistory = (batchId: string, requestBatchId: string) =>
  batchId === requestBatchId || batchId.startsWith(`${requestBatchId}.`);

const hasSplitHistory = computed(() => {
  const s = props.session;
  if (!s || selectedBatchIndex.value < 0) return false;
  const batch = s.batches[selectedBatchIndex.value];
  if (!batch) return false;
  return (s.requests ?? []).some(
    (r) => r.batchId !== batch.id && includesBatchHistory(batch.id, r.batchId),
  );
});

const metricsLabel = computed(() => {
  if (selectedBatchIndex.value < 0) return '全章累计';
  return hasSplitHistory.value ? '当前批次（含拆分前）' : '当前批次';
});

const onUpdateShow = (val: boolean) => {
  if (!val) {
    selectedBatchIndex.value = -1;
  }
  emit('update:show', val);
};

interface ThinkingEntry {
  attempt: number;
  text: string;
}

// 提取各个批次的思考过程 (按尝试轮次细分)
const batchThinkingList = computed(() => {
  const s = props.session;
  if (!s) return new Map<string, ThinkingEntry[]>();
  const map = new Map<string, ThinkingEntry[]>();
  const attemptMap = new Map<string, number>();

  let currentBatchId = '';
  for (const message of s.messages) {
    if (message.role === 'user') {
      const content =
        typeof message.content === 'string'
          ? message.content
          : Array.isArray(message.content)
            ? message.content
                .map((b) => (b.type === 'text' ? b.text : ''))
                .join('')
            : '';
      const match = content.match(/<current_batch\s+id="([^"]+)">/);
      if (match) {
        currentBatchId = match[1];
      }
    } else if (message.role === 'assistant') {
      let bId = currentBatchId;
      for (const block of message.content) {
        if (
          block.type === 'toolCall' &&
          block.arguments &&
          typeof block.arguments === 'object' &&
          'batchId' in block.arguments
        ) {
          bId = String((block.arguments as Record<string, unknown>).batchId);
        }
      }
      const nextAttempt = (attemptMap.get(bId) ?? 0) + 1;
      attemptMap.set(bId, nextAttempt);

      for (const block of message.content) {
        const text =
          block.type === 'thinking'
            ? block.thinking
            : (block as any).thinking ?? '';
        if (text) {
          if (!map.has(bId)) map.set(bId, []);
          map.get(bId)!.push({ attempt: nextAttempt, text });
        }
      }
    }
  }
  return map;
});

const formatBatchThinking = (
  entries: ThinkingEntry[],
  hasMultipleAttempts: boolean,
) => {
  if (!entries.length) return '';
  if (entries.length === 1 && !hasMultipleAttempts) {
    return entries[0].text;
  }
  return entries
    .map((e) => {
      const title =
        e.attempt === 1
          ? '【第 1 次尝试思考】'
          : `【第 ${e.attempt} 次尝试思考（重试修复）】`;
      return `${title}\n${e.text}`;
    })
    .join('\n\n');
};

// 当前展示的思考过程
const currentThinking = computed(() => {
  const s = props.session;
  if (!s) return '';
  const map = batchThinkingList.value;

  if (selectedBatchIndex.value === -1) {
    // 全章：汇总所有批次的思考
    const parts: string[] = [];
    for (const [batchId, entries] of map) {
      if (entries.length) {
        const reqs = (s.requests ?? []).filter((r) => r.batchId === batchId);
        const formatted = formatBatchThinking(entries, reqs.length > 1);
        parts.push(`【批次 ${batchId}】\n${formatted}`);
      }
    }
    return parts.join('\n\n--------------------\n\n');
  } else {
    // 单批次：只显示该批次的思考
    const batch = s.batches[selectedBatchIndex.value];
    if (!batch) return '';
    return [...map]
      .filter(([id]) => includesBatchHistory(batch.id, id))
      .map(([id, entries]) => {
        const reqs = s.requests.filter((r) => r.batchId === id);
        return `【批次 ${id}${id === batch.id ? '' : ' · 拆分前'}】\n${formatBatchThinking(entries, reqs.length > 1)}`;
      })
      .join('\n\n');
  }
});

// 筛选请求指标数据
const activeMetrics = computed(() => {
  const s = props.session;
  if (!s) {
    return { input: 0, cacheRead: 0, output: 0, isBatch: false };
  }
  const requests = s.requests ?? [];
  let targetRequests = requests;
  let isBatch = false;

  if (selectedBatchIndex.value >= 0) {
    const batch = s.batches[selectedBatchIndex.value];
    if (batch) {
      targetRequests = requests.filter((r) =>
        includesBatchHistory(batch.id, r.batchId),
      );
      isBatch = true;
    }
  }

  const input = targetRequests.reduce(
    (sum, r) => sum + (r.usage?.input ?? 0),
    0,
  );
  const cacheRead = targetRequests.reduce(
    (sum, r) => sum + (r.usage?.cacheRead ?? 0),
    0,
  );
  const output = targetRequests.reduce(
    (sum, r) => sum + (r.usage?.output ?? 0),
    0,
  );

  return { input, cacheRead, output, isBatch };
});

// 重试统计与一次过判定
const batchAttemptInfo = computed(() => {
  const s = props.session;
  if (!s) return null;
  if (selectedBatchIndex.value === -1) {
    let onePassCount = 0;
    let retryBatchCount = 0;
    const retryBatchIds: string[] = [];
    for (const id of new Set(s.requests.map((r) => r.batchId))) {
      const reqs = s.requests.filter((r) => r.batchId === id);
      if (reqs.length === 1 && reqs[0].status === 'accepted') {
        onePassCount++;
      } else if (reqs.length > 1) {
        retryBatchCount++;
        retryBatchIds.push('第' + id.replace(/^b0*/, '') + '批');
      }
    }
    return {
      isBatch: false as const,
      onePassCount,
      retryBatchCount,
      retryBatchIds,
    };
  } else {
    const batch = s.batches[selectedBatchIndex.value];
    if (!batch) return null;
    const reqs = (s.requests ?? []).filter((r) =>
      includesBatchHistory(batch.id, r.batchId),
    );
    const count = reqs.length;
    const last = reqs[reqs.length - 1];
    const isOnePass = count === 1 && last?.status === 'accepted';
    return {
      isBatch: true as const,
      batchIndex: selectedBatchIndex.value + 1,
      batchId: batch.id,
      requestCount: count,
      isOnePass,
      requests: reqs,
    };
  }
});

// 段落列表计算
const displayParagraphs = computed(() => {
  const s = props.session;
  if (!s) return [];
  const batches = s.batches ?? [];
  const allParagraphs = s.paragraphs ?? [];
  let activeParagraphs = allParagraphs;

  if (selectedBatchIndex.value >= 0 && batches[selectedBatchIndex.value]) {
    const idSet = new Set(batches[selectedBatchIndex.value].paragraphIds);
    activeParagraphs = allParagraphs.filter((p) => idSet.has(p.id));
  }

  const currentBatchParaIds = new Set(batches[s.cursor]?.paragraphIds ?? []);

  const list: {
    jp: string;
    zh: string;
    status: 'done' | 'translating' | 'pending' | 'error';
  }[] = [];
  for (let idx = 0; idx < activeParagraphs.length; idx++) {
    const p = activeParagraphs[idx];
    if (p.empty) {
      list.push({ jp: '', zh: '', status: 'pending' });
      continue;
    }
    const zh =
      s.translations[p.id] ??
      (s.finalParagraphs && selectedBatchIndex.value === -1
        ? s.finalParagraphs[idx] ?? ''
        : '');

    let status: 'done' | 'translating' | 'pending' | 'error' = 'pending';
    if (zh) {
      status = 'done';
    } else if (currentBatchParaIds.has(p.id)) {
      status = s.pauseReason ? 'error' : 'translating';
    }

    list.push({ jp: p.source, zh, status });
  }
  return list;
});

const batchBtnType = (
  index: number,
): 'default' | 'success' | 'warning' | 'error' | 'info' => {
  const s = props.session;
  if (!s) return 'default';
  if (s.phase === 'completed') return 'success';
  if (index < s.cursor) return 'success';
  if (index === s.cursor) return s.pauseReason ? 'error' : 'info';
  return 'default';
};

const doneCount = computed(() => {
  return props.session ? Object.keys(props.session.translations).length : 0;
});
const totalCount = computed(() => {
  return props.session
    ? props.session.paragraphs.filter((p) => !p.empty).length
    : 0;
});

const reviewThinking = computed(() => {
  const review = props.session?.review;
  return (review?.messages.slice(review.initialMessageCount) ?? [])
    .flatMap((message) =>
      message.role === 'assistant'
        ? message.content.flatMap((block) =>
            block.type === 'thinking' && block.thinking ? [block.thinking] : [],
          )
        : [],
    )
    .join('\n\n');
});

const reviewMetrics = computed(() => {
  const requests = props.session?.review?.requests ?? [];
  const metrics: { key: keyof DeltaUsagePresence; label: string }[] = [
    { key: 'input', label: '非缓存输入' },
    { key: 'cacheRead', label: '缓存输入' },
    { key: 'cacheWrite', label: '缓存写入' },
    { key: 'output', label: '输出' },
  ];
  return metrics.map(({ key, label }) => {
    const reported = requests.filter(
      (request) => request.usagePresence?.[key] && request.usage,
    );
    const total = reported.reduce(
      (sum, request) => sum + request.usage![key],
      0,
    );
    const value = reported.length ? total.toLocaleString() : '未返回';
    return {
      key,
      label,
      value: `${value}（覆盖 ${reported.length}/${requests.length} 请求）`,
    };
  });
});

const reviewSummary = computed(() => {
  const review = props.session?.review;
  if (!review) return '未开启';
  if (review.skipped) return '已跳过';
  const unresolved = review.unresolved?.length ?? 0;
  if (unresolved) return `未解决 ${unresolved} 项`;
  if (review.completed)
    return `已完成 · 修改 ${review.changes?.length ?? 0} 段`;
  return props.session?.pauseReason ? '已暂停' : '审校中';
});

const canSkipReview = computed(
  () =>
    !props.actionsDisabled &&
    props.session?.phase === 'reviewing' &&
    !!props.session.pauseReason,
);
function skipReview() {
  if (canSkipReview.value && props.session)
    emit('skipReview', props.session.id);
}
function restartDelta() {
  if (!props.actionsDisabled && props.session)
    emit('restartDelta', props.session.id);
}
</script>

<template>
  <c-modal
    :show="show"
    @update:show="onUpdateShow"
    :title="title"
    style="width: min(920px, 95vw)"
  >
    <template #header-extra>
      <div v-if="session" class="delta-modal-header-extra">
        <div class="delta-header-stats">
          <n-tag size="small" :bordered="false" round type="primary">
            Delta
          </n-tag>
          <n-tag size="small" :bordered="false">
            共 {{ totalCount }} 段 · {{ session.batches.length }} 批
          </n-tag>
          <n-tag size="small" :bordered="false" type="success">
            ✓ {{ doneCount }}
          </n-tag>
          <n-tag
            v-if="session.phase === 'translating'"
            size="small"
            :bordered="false"
            type="info"
          >
            ● 第 {{ session.cursor + 1 }}/{{ session.batches.length }} 批进行中
          </n-tag>
          <n-tag
            v-else-if="session.phase === 'reviewing'"
            size="small"
            :bordered="false"
            type="info"
          >
            审校中
          </n-tag>
          <n-tag
            v-else-if="session.phase === 'completed'"
            size="small"
            :bordered="false"
            type="success"
          >
            ✓ 全章完成
          </n-tag>
          <n-tag
            v-if="session.pauseReason"
            size="small"
            :bordered="false"
            type="error"
          >
            ✕ 暂停
          </n-tag>
        </div>
        <n-divider style="margin: 6px 0 6px" />
      </div>
    </template>

    <div v-if="session" class="delta-modal-body">
      <!-- 两行元数据信息：第1行翻译器与批次状态，第2行Token指标 -->
      <div class="delta-meta-container">
        <!-- 第 1 行：翻译器信息 + 一次通过 / 重试 / 拆分状态胶囊 -->
        <n-flex :size="8" align="center" class="delta-meta-row">
          <n-text depth="3" class="delta-meta-label">翻译器：</n-text>
          <n-text class="delta-meta-value">
            {{ session.model.model }} · {{ session.model.protocol }}
          </n-text>

          <!-- 一次通过 / 重试状态胶囊 -->
          <template v-if="batchAttemptInfo">
            <template v-if="batchAttemptInfo.isBatch">
              <n-tag
                v-if="batchAttemptInfo.isOnePass"
                size="tiny"
                :bordered="false"
                type="success"
              >
                ✓ 一次通过
              </n-tag>
              <n-popover
                v-else-if="batchAttemptInfo.requestCount > 1"
                trigger="hover"
                placement="bottom-start"
              >
                <template #trigger>
                  <n-tag
                    size="tiny"
                    :bordered="false"
                    type="warning"
                    style="cursor: pointer"
                  >
                    重试 {{ batchAttemptInfo.requestCount - 1 }} 次 (共
                    {{ batchAttemptInfo.requestCount }} 次请求)
                  </n-tag>
                </template>
                <div style="font-size: 12px; max-width: 380px; padding: 2px">
                  <div style="font-weight: 500; margin-bottom: 6px">
                    请求记录明细
                  </div>
                  <div
                    v-for="(r, idx) in batchAttemptInfo.requests"
                    :key="r.requestId"
                    style="
                      display: flex;
                      gap: 8px;
                      align-items: center;
                      margin-top: 4px;
                    "
                  >
                    <n-tag
                      size="tiny"
                      :bordered="false"
                      :type="r.status === 'accepted' ? 'success' : 'error'"
                    >
                      {{ r.batchId }} · 尝试 {{ idx + 1 }}
                    </n-tag>
                    <span
                      :style="{
                        color:
                          r.status === 'accepted'
                            ? undefined
                            : themeVars.errorColor,
                      }"
                    >
                      {{
                        r.status === 'accepted'
                          ? '✓ 校验通过'
                          : r.error || r.status
                      }}
                    </span>
                  </div>
                </div>
              </n-popover>
              <n-tag
                v-if="visibleBatch?.id.includes('.')"
                size="tiny"
                :bordered="false"
                type="info"
              >
                拆分批次 ({{ visibleBatch.paragraphIds.length }} 段)
              </n-tag>
            </template>
            <template v-else>
              <n-tag
                v-if="
                  batchAttemptInfo.retryBatchCount === 0 &&
                  batchAttemptInfo.onePassCount > 0
                "
                size="tiny"
                :bordered="false"
                type="success"
              >
                ✓ 全部批次一次通过
              </n-tag>
              <n-tag
                v-else-if="batchAttemptInfo.retryBatchCount > 0"
                size="tiny"
                :bordered="false"
                type="warning"
              >
                {{ batchAttemptInfo.retryBatchCount }} 批存在重试 ({{
                  batchAttemptInfo.retryBatchIds.join('、')
                }})
              </n-tag>
            </template>
          </template>
        </n-flex>

        <!-- 第 2 行：批次Token指标 (非缓存输入 xxxx 缓存输入 xxxx 输出 xxxx) -->
        <n-flex :size="8" align="center" class="delta-meta-row">
          <n-text depth="3" class="delta-meta-label">
            初译 {{ metricsLabel }}：
          </n-text>
          <n-tag size="tiny" :bordered="false">
            非缓存输入 {{ activeMetrics.input.toLocaleString() }}
          </n-tag>
          <n-tag size="tiny" :bordered="false" type="success">
            缓存输入 {{ activeMetrics.cacheRead.toLocaleString() }}
          </n-tag>
          <n-tag size="tiny" :bordered="false" type="info">
            输出 {{ activeMetrics.output.toLocaleString() }}
          </n-tag>
        </n-flex>
      </div>

      <!-- 批次选择按钮 -->
      <div v-if="session.batches.length > 1" class="delta-batch-tabs">
        <n-button
          size="small"
          secondary
          :type="selectedBatchIndex === -1 ? 'primary' : 'default'"
          :style="
            selectedBatchIndex === -1
              ? {
                  outline: `2px solid ${themeVars.primaryColor}`,
                  outlineOffset: '1px',
                }
              : undefined
          "
          @click="selectedBatchIndex = -1"
        >
          全章
        </n-button>
        <n-button
          v-for="(batch, i) of session.batches"
          :key="batch.id"
          size="small"
          secondary
          :type="batchBtnType(i)"
          :style="
            selectedBatchIndex === i
              ? {
                  outline: `2px solid ${themeVars.primaryColor}`,
                  outlineOffset: '1px',
                }
              : undefined
          "
          @click="selectedBatchIndex = i"
        >
          {{ batch.id.replace(/^b0*/, '') }}
        </n-button>
      </div>

      <!-- 错误警告提示 (仅在会话真正暂停时呈现) -->
      <n-alert
        v-if="session.pauseReason"
        type="warning"
        :title="session.phase === 'reviewing' ? '审校暂停' : '翻译暂停'"
        :bordered="false"
        style="margin-bottom: 8px"
      >
        {{ session.pauseReason }}
      </n-alert>

      <!-- 思考过程 (无 AI 推理 badge，按批次或全章独立呈现) -->
      <n-collapse v-if="currentThinking" class="delta-thinking-collapse">
        <n-collapse-item title="初译思考 / 摘要" name="thinking">
          <div class="delta-thinking-content">{{ currentThinking }}</div>
        </n-collapse-item>
      </n-collapse>

      <n-card v-if="session.review" size="small" style="margin-bottom: 12px">
        <template #header>章末 Review · {{ reviewSummary }}</template>
        <n-flex vertical :size="8">
          <n-text depth="3" style="font-size: 12px">
            {{
              session.review.options.mode === 'append'
                ? '追加原会话'
                : '新开会话'
            }}
            · 已请求 {{ session.review.totalAttempts }} 次 · 重试窗口
            {{ session.review.window }}
          </n-text>
          <n-flex :size="6">
            <n-tag
              v-for="metric of reviewMetrics"
              :key="metric.key"
              size="small"
              :bordered="false"
            >
              审校 {{ metric.label }} {{ metric.value }}
            </n-tag>
          </n-flex>
          <n-alert
            v-if="session.review.unresolved?.length"
            type="warning"
            :show-icon="false"
          >
            <n-flex vertical :size="4">
              <n-text>未解决 {{ session.review.unresolved.length }} 项</n-text>
              <n-text
                v-for="finding of session.review.unresolved"
                :key="finding.paragraphId"
                style="overflow-wrap: anywhere"
              >
                {{ finding.paragraphId }}：{{ finding.reason }}
              </n-text>
            </n-flex>
          </n-alert>
          <n-collapse v-if="reviewThinking || session.review.changes?.length">
            <n-collapse-item
              v-if="reviewThinking"
              title="审校思考 / 摘要"
              name="review-thinking"
            >
              <div class="delta-thinking-content">{{ reviewThinking }}</div>
            </n-collapse-item>
            <n-collapse-item
              v-if="session.review.changes?.length"
              :title="`修改 ${session.review.changes.length} 段`"
              name="review-changes"
            >
              <n-flex vertical :size="12">
                <div
                  v-for="change of session.review.changes"
                  :key="change.paragraphId"
                  style="overflow-wrap: anywhere"
                >
                  <n-text strong>
                    {{ change.paragraphId }} · {{ change.category }}
                  </n-text>
                  <div>
                    <n-text depth="3">原译：</n-text>
                    {{
                      session.review.originalTranslations[change.paragraphId]
                    }}
                  </div>
                  <div>
                    <n-text depth="3">审校：</n-text>
                    {{ change.translation }}
                  </div>
                  <div>
                    <n-text depth="3">原因：</n-text>
                    {{ change.reason }}
                  </div>
                </div>
              </n-flex>
            </n-collapse-item>
          </n-collapse>
        </n-flex>
      </n-card>

      <!-- 原文 vs 译文 双语对照表格 -->
      <n-table :bordered="false" size="small" class="delta-preview-table">
        <thead>
          <tr>
            <th style="width: 50%">原文</th>
            <th style="width: 50%">译文</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(p, i) of displayParagraphs" :key="i">
            <td class="delta-jp">{{ p.jp }}</td>
            <td class="delta-zh">
              <template v-if="p.zh">{{ p.zh }}</template>
              <span
                v-else-if="p.status === 'translating'"
                class="delta-translating"
              >
                （正在翻译...）
              </span>
              <span v-else-if="p.jp" class="delta-none">（待翻译）</span>
            </td>
          </tr>
        </tbody>
      </n-table>
    </div>
    <template v-if="session" #action>
      <n-flex :size="8">
        <c-button
          v-if="session.phase === 'reviewing' && session.pauseReason"
          label="跳过本章审校"
          :disabled="!canSkipReview"
          @action="skipReview"
        />
        <c-button
          label="本章重新翻译"
          :disabled="actionsDisabled"
          @action="restartDelta"
        />
      </n-flex>
    </template>
  </c-modal>
</template>

<style scoped>
.delta-modal-header-extra {
  margin-top: -20px;
}
.delta-header-stats {
  display: flex;
  align-items: center;
  gap: 8px;
}
.delta-meta-container {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 4px 2px 8px;
}
.delta-meta-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.delta-meta-label {
  font-size: 13px;
  line-height: 1.4;
}
.delta-meta-value {
  font-size: 13px;
  line-height: 1.4;
}
.delta-batch-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 4px 2px 10px;
}
.delta-batch-tabs .n-button {
  min-width: 0;
}
.delta-thinking-collapse {
  margin: 6px 0 10px;
  background: rgba(128, 128, 128, 0.05);
  border-radius: 6px;
  padding: 0 10px;
}
.delta-thinking-content {
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  color: v-bind('themeVars.textColor2');
  max-height: 240px;
  overflow-y: auto;
  padding: 6px 0;
}
.delta-preview-table {
  margin-top: 8px;
  table-layout: fixed;
}
.delta-preview-table td {
  vertical-align: top;
  line-height: 1.7;
}

@media (min-width: 769px) {
  .delta-jp,
  .delta-zh {
    opacity: 1;
  }
}

@media (max-width: 768px) {
  .delta-preview-table thead {
    display: none;
  }
  .delta-preview-table tr {
    display: block;
    margin-bottom: 10px;
    padding-bottom: 8px;
    border-bottom: 1px solid rgba(128, 128, 128, 0.2);
  }
  .delta-preview-table td {
    display: block;
    width: 100% !important;
    padding: 3px 8px;
    border: none;
  }
  .delta-jp {
    font-weight: 500;
    opacity: 1;
  }
  .delta-zh {
    opacity: 0.6;
  }
}

.delta-none {
  opacity: 0.4;
  font-style: italic;
}
.delta-translating {
  color: v-bind('themeVars.infoColor');
  font-size: 12px;
}
</style>
