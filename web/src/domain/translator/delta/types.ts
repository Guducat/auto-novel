import type {
  DeltaChapterSession,
  DeltaMetadata,
  DeltaSessionStore,
} from '@auto-novel/translator';
import type { ChapterDetail } from '../TranslationTask/types';
import type { ChapterMeta } from '../TaskState';

export interface DeltaSessionRepository extends DeltaSessionStore {
  get(id: string): Promise<DeltaChapterSession | undefined>;
  list(): Promise<DeltaChapterSession[]>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

export interface DeltaTaskSource {
  novelId: string;
  volumeId?: string;
  metadata: DeltaMetadata;
  chapters: ChapterMeta[];
  readChapter(chapterId: string): Promise<ChapterDetail>;
  uploadChapter(
    chapterId: string,
    glossaryId: string,
    paragraphs: string[],
  ): Promise<void>;
}
