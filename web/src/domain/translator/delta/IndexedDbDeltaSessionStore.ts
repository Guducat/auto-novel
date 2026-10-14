import { openDB, type DBSchema } from 'idb';
import type { DeltaChapterSession } from '@auto-novel/translator';
import type { DeltaSessionRepository } from './types';

interface DeltaDatabase extends DBSchema {
  sessions: { key: string; value: DeltaChapterSession };
}

/** A separate database keeps old segment-cache cleanup away from chapter drafts. */
export class IndexedDbDeltaSessionStore implements DeltaSessionRepository {
  private database;
  constructor(name = 'gpt-delta-sessions') {
    this.database = openDB<DeltaDatabase>(name, 1, {
      upgrade(db) {
        db.createObjectStore('sessions', { keyPath: 'id' });
      },
    });
  }
  async save(session: DeltaChapterSession): Promise<void> {
    const db = await this.database;
    const tx = db.transaction('sessions', 'readwrite');
    const previous = await tx.store.get(session.id);
    if (previous && session.revision !== previous.revision + 1) {
      tx.abort();
      await tx.done.catch(() => {});
      throw new Error('Delta 断点版本冲突，已停止以保留已保存的回复');
    }
    await tx.store.put(structuredClone(session));
    await tx.done;
  }
  async get(id: string) {
    return (await this.database).get('sessions', id);
  }
  async list() {
    return (await this.database).getAll('sessions');
  }
  async delete(id: string) {
    await (await this.database).delete('sessions', id);
  }
  async clear() {
    await (await this.database).clear('sessions');
  }
  async close() {
    (await this.database).close();
  }
}
