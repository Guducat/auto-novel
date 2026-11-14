import { describe, expect, it } from 'vitest';
import {
  findHarnessPresetGroup,
  getHarnessModelPreset,
} from '../src/harness/presets';
import { parseBatchOutput } from '../src/harness/output';

describe('EXP Harness presets', () => {
  for (const id of ['deepseek', 'deepseek-exp-b']) {
    it(`${id} applies DeepSeek rules to arbitrary models and connections`, () => {
      const group = findHarnessPresetGroup(id)!;
      for (const model of ['mimo-v2-flash', 'gemini-test']) {
        const preset = getHarnessModelPreset(group, model, {
          endpoint: 'https://example.com/v1',
          profile: { id: 'gemini', values: { reasoning_effort: 'high' } },
        });
        expect(preset.model).toBe(model);
        expect(preset.endpoint).toBe('https://example.com/v1');
        expect(preset.protocol).toBe('openai-completions');
        expect(preset.rules).toBe(group.models[0].rules);
        expect(preset.contextMode).toBe(group.models[0].contextMode);
        expect(preset.requestParams).toEqual({ reasoning_effort: 'high' });
        expect(preset.cost).toEqual({
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        });
      }
    });
  }

  it('preserves legacy Responses connections and accepts plain paragraph output', () => {
    const group = findHarnessPresetGroup('deepseek')!;
    const preset = getHarnessModelPreset(group, 'deepseek-v4-pro');
    expect(preset.protocol).toBe('openai-responses');
    expect(preset.outputFormat).toBe('paragraph-id');
    expect(preset.requestParams).toEqual({ reasoning: { effort: 'high' } });
    expect(
      parseBatchOutput('p0000#你好\np0001#世界', preset.outputFormat, [
        { id: 'p0000', text: 'こんにちは' },
        { id: 'p0001', text: '世界' },
      ]),
    ).toEqual(['你好', '世界']);
  });

  it('honors a custom endpoint for a known model on a legacy worker', () => {
    const group = findHarnessPresetGroup('deepseek')!;
    const preset = getHarnessModelPreset(group, 'deepseek-v4-pro', {
      endpoint: 'https://example.com/v1',
    });
    expect(preset.endpoint).toBe('https://example.com/v1');
    expect(preset.protocol).toBe('openai-responses');
    expect(preset.requestParams).toEqual({ reasoning: { effort: 'high' } });
    expect(preset.cost).toEqual(group.models[1].cost);
  });

  it('uses the selected Responses or Anthropic protocol without changing shared presets', () => {
    const group = findHarnessPresetGroup('deepseek-exp-b')!;
    const original = structuredClone(group.models);
    for (const [id, protocol] of [
      ['openai-responses', 'openai-responses'],
      ['anthropic', 'anthropic-messages'],
    ] as const) {
      const preset = getHarnessModelPreset(group, 'custom-model', {
        endpoint: 'https://example.com',
        profile: { id, values: {} },
      });
      expect(preset.protocol).toBe(protocol);
      expect(preset.requestParams).toEqual({});
    }
    expect(group.models).toEqual(original);
  });
});
