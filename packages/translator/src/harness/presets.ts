import type { PiAiProtocol } from '../translator/pi-ai-api';
import type { ModelCost } from '@earendil-works/pi-ai';
import { deepseekPresets } from './presets/deepseek';
import {
  buildOpenAiProfileParams,
  openAiProfiles,
  type openAiProfileId,
} from '../translator/profiles/openai';
import type { ProfileValues } from '../translator/profiles/types';

export type HarnessOutputFormat = 'json' | 'paragraph-id' | 'lines';

/** 每个模型独立声明协议、翻译准则、输出格式和 API 参数。 */
export interface HarnessPreset {
  model: string;
  endpoint: string;
  protocol: PiAiProtocol;
  outputFormat: HarnessOutputFormat;
  /** 临时 A/B 实验：默认重建单条 user 请求，B 保留完整对话。 */
  contextMode?: 'rebuild' | 'conversation';
  rules: string;
  requestParams: Record<string, unknown>;
  /** 每百万 token 的人民币参考单价，仅用于费用估算。 */
  cost: ModelCost;
}

export interface HarnessPresetGroup {
  id: string;
  label: string;
  mode: 'harness';
  models: HarnessPreset[];
}

/** 工作区入口和表单共用的预设目录。 */
export const harnessPresets = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    mode: 'harness',
    models: deepseekPresets,
  },
  {
    id: 'deepseek-exp-b',
    label: 'DeepSeek 实验 B',
    mode: 'harness',
    models: deepseekPresets.map((preset) => ({
      ...preset,
      contextMode: 'conversation' as const,
    })),
  },
] as const satisfies readonly HarnessPresetGroup[];

export type HarnessPresetId = (typeof harnessPresets)[number]['id'];

export function findHarnessPresetGroup(
  id: string | undefined,
): HarnessPresetGroup | undefined {
  return harnessPresets.find((preset) => preset.id === id);
}

export function getHarnessModelPreset(
  group: HarnessPresetGroup,
  model: string,
  connection?: {
    endpoint: string;
    profile?: { id: openAiProfileId; values?: ProfileValues };
  },
): HarnessPreset {
  // EXP：任意模型复用所选组的翻译规则与上下文模式。
  const matched = group.models.find((preset) => preset.model === model);
  const preset = matched ?? group.models[0];
  const profile = connection?.profile;
  const apiFormat = openAiProfiles.find(
    (item) => item.id === profile?.id,
  )?.apiFormat;
  return {
    ...preset,
    model,
    endpoint: connection?.endpoint ?? preset.endpoint,
    protocol:
      apiFormat === 'openai'
        ? 'openai-completions'
        : apiFormat ?? preset.protocol,
    requestParams: profile
      ? buildOpenAiProfileParams(profile.id, profile.values)
      : matched
        ? preset.requestParams
        : {},
    // 未收录模型的价格未知，不能套用 DeepSeek 的价格。
    cost: matched
      ? preset.cost
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}
