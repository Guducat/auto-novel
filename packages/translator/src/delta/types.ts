import type {
  AssistantMessage,
  Message,
  Tool,
  Usage,
} from '@earendil-works/pi-ai';
import type { PiAiProtocol } from '../translator/pi-ai-api';

export interface DeltaChapterIdentity {
  taskId: string;
  taskCreatedAt?: number;
  novelId: string;
  volumeId?: string;
  chapterId: string;
  chapterKey?: string;
  taskDesc?: string;
  title?: string;
}

export interface DeltaModelSnapshot {
  protocol: PiAiProtocol;
  endpoint: string;
  model: string;
  profile?: string;
  requestParams?: Record<string, unknown>;
}

export interface DeltaMetadata {
  title?: string;
  description?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  chapterTitle?: string;
}

export interface DeltaParagraph {
  id: string;
  source: string;
  indent: string;
  empty: boolean;
}

export interface DeltaBatch {
  /** Split children append .1/.2 to their parent's stable ID. */
  id: string;
  paragraphIds: string[];
}

export interface DeltaUsagePresence {
  input: boolean;
  output: boolean;
  cacheRead: boolean;
  cacheWrite: boolean;
}

export interface DeltaRequestRecord {
  requestId: string;
  batchId: string;
  window: number;
  attempt: number;
  status: 'pending' | 'received' | 'accepted' | 'rejected' | 'error';
  usage?: Usage;
  usagePresence?: DeltaUsagePresence;
  error?: string;
}

export interface DeltaChapterSession {
  id: string;
  runId: string;
  workerId: string;
  identity: DeltaChapterIdentity;
  schemaVersion: 1;
  revision: number;
  promptVersion: number;
  source: string[];
  sourceHash: string;
  metadata: DeltaMetadata;
  glossaryId: string;
  glossary: Record<string, string>;
  preferences: string;
  model: DeltaModelSnapshot;
  paragraphs: DeltaParagraph[];
  batches: DeltaBatch[];
  cursor: number;
  translations: Record<string, string>;
  systemPrompt: string;
  tools: Tool[];
  messages: Message[];
  promptCursor: number;
  requests: DeltaRequestRecord[];
  pendingAssistant?: {
    requestId: string;
    message: AssistantMessage;
    usagePresence: DeltaUsagePresence;
  };
  retry: {
    batchId: string;
    window: number;
    attempts: number;
    totalAttempts: number;
    outputBudgetIncreased: boolean;
    nextRequestParams?: Record<string, unknown>;
  };
  phase:
    | 'translating'
    | 'reviewing'
    | 'readyToSubmit'
    | 'submitting'
    | 'completed';
  reviewOptions?: DeltaReviewOptions;
  review?: DeltaReviewState;
  pauseReason?: string;
  finalParagraphs?: string[];
  finalHash?: string;
  previousTranslationHash?: string;
}

export interface CreateDeltaSessionInput {
  runId: string;
  workerId: string;
  identity: DeltaChapterIdentity;
  source: string[];
  metadata?: DeltaMetadata;
  glossaryId: string;
  glossary: Record<string, string>;
  model: DeltaModelSnapshot;
  preferences?: string;
  batchMaxChars?: number;
  batchMaxParagraphs?: number;
  previousTranslationHash?: string;
  reviewOptions?: DeltaReviewOptions;
}

/** A save commits the entire session atomically before the runner advances. */
export interface DeltaSessionStore {
  save(session: DeltaChapterSession): Promise<void>;
}

export interface DeltaSubmitBatch {
  batchId: string;
  entries: { paragraphId: string; translation: string }[];
}

export interface DeltaReviewOptions {
  enabled: boolean;
  mode: 'new' | 'append';
}

export type DeltaChapterContext =
  | {
      available: true;
      chapterId: string;
      title: string;
      source: string[];
      translation?: string[];
    }
  | { available: false; reason: string };

export const deltaReviewCategories = [
  'accuracy',
  'omission',
  'fluency',
  'terminology',
  'format',
] as const;
export const deltaReviewContextOffsets = [-2, -1, 1, 2] as const;
export type DeltaReviewCategory = (typeof deltaReviewCategories)[number];

export interface DeltaReviewChange {
  paragraphId: string;
  translation: string;
  category: DeltaReviewCategory;
  reason: string;
}

export interface DeltaReviewIssue {
  paragraphId: string;
  reason: string;
}

export interface DeltaSubmitReview {
  reviewId: string;
  draftHash: string;
  changes: DeltaReviewChange[];
  unresolved: DeltaReviewIssue[];
}

export interface DeltaReviewState {
  promptVersion?: number;
  id: string;
  options: DeltaReviewOptions;
  draftHash: string;
  originalTranslations: Record<string, string>;
  systemPrompt: string;
  tools: Tool[];
  messages: Message[];
  initialMessageCount: number;
  requests: DeltaRequestRecord[];
  pendingAssistant?: DeltaChapterSession['pendingAssistant'];
  attempts: number;
  failures: number;
  totalAttempts: number;
  window: number;
  contextReads: number;
  changes?: DeltaReviewChange[];
  unresolved?: DeltaReviewIssue[];
  completed: boolean;
  skipped?: boolean;
}
