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
  phase: 'translating' | 'readyToSubmit' | 'submitting' | 'completed';
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
}

/** A save commits the entire session atomically before the runner advances. */
export interface DeltaSessionStore {
  save(session: DeltaChapterSession): Promise<void>;
}

export interface DeltaSubmitBatch {
  batchId: string;
  entries: { paragraphId: string; translation: string }[];
}
