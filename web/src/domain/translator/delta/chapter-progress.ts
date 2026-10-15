import type { DeltaChapterSession } from '@auto-novel/translator';
import type { ChapterMeta } from '../TaskState';

/** Local checkpoints remain visible when normal task filtering omits already uploaded chapters. */
export function syncDeltaChapterProgress(
  chapters: ChapterMeta[],
  session: DeltaChapterSession,
): ChapterMeta[] {
  const index = chapters.findIndex(
    (chapter) => chapter.chapterId === session.identity.chapterId,
  );
  const chapter: ChapterMeta = {
    ...(index < 0
      ? {
          chapterId: session.identity.chapterId,
          title:
            session.identity.title ??
            session.metadata.chapterTitle ??
            session.identity.chapterId,
          order: chapters.length,
        }
      : chapters[index]),
    status:
      session.phase === 'completed'
        ? 'done'
        : session.pauseReason
          ? session.pauseReason.includes('停止')
            ? 'pending'
            : 'paused'
          : 'translating',
    segmentProgress: {
      completed:
        session.phase === 'completed' ? session.batches.length : session.cursor,
      total: session.batches.length,
    },
  };
  return index < 0
    ? [...chapters, chapter]
    : chapters.map((item, i) => (i === index ? chapter : item));
}
