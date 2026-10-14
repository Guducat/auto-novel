import { TranslateTaskDescriptor } from '@/model/Translator';
import { WebNovelApi, WenkuNovelApi } from '@/api';
import { createTranslationTask } from '../TranslationTask/createTranslationTask';
import type { DeltaTaskSource } from './types';
import type { TranslationTask } from '../TranslationTask/types';

/** Delta reuses data access only; no legacy executor or segment queue is involved. */
export async function createDeltaTaskSource(
  taskDesc: string,
): Promise<DeltaTaskSource> {
  const { desc, params } = TranslateTaskDescriptor.parse(taskDesc);
  const task = createTranslationTask(desc, 'gpt', params);
  const chapterTasks = new Map<string, TranslationTask>();
  await task.initMeta();
  const metadata = {
    title: task.description,
    description: '',
    sourceLanguage: '日语',
    targetLanguage: '简体中文',
  };
  if (desc.type === 'web') {
    const novel = await WebNovelApi.getNovel(desc.providerId, desc.novelId);
    metadata.title = novel.titleJp;
    metadata.description = novel.introductionJp;
  } else if (desc.type === 'wenku') {
    const novel = await WenkuNovelApi.getNovel(desc.novelId);
    metadata.title = novel.title;
    metadata.description = novel.introduction;
  } else metadata.title = desc.volumeId;
  return {
    novelId: JSON.stringify(desc),
    volumeId: desc.type === 'web' ? undefined : desc.volumeId,
    metadata,
    chapters: task.chapters,
    readChapter: async (chapterId) => {
      // Fresh glossary is necessary for local uploads too: LocalTranslationTask
      // otherwise keeps the glossary captured by its first initMeta call.
      const chapterTask = createTranslationTask(desc, 'gpt', params);
      await chapterTask.initMeta();
      chapterTasks.set(chapterId, chapterTask);
      return chapterTask.fetchChapter(chapterId);
    },
    uploadChapter: (chapterId, glossaryId, paragraphs) =>
      chapterTasks
        .get(chapterId)!
        .uploadChapter(chapterId, glossaryId, paragraphs),
  };
}
