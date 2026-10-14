import { watch } from 'vue';

export type WorkspaceMode = 'pipeline' | 'delta';

/** Owns the same-origin GPT beta lease until all chapter work has drained. */
export class WorkspaceExecution {
  private mode?: WorkspaceMode;
  private draining = false;
  private acquisition = Promise.resolve();
  private lease?: Promise<unknown>;
  private release?: () => void;
  private drainingPromise?: Promise<boolean>;
  private starts = new Set<Promise<void>>();
  private maintaining = false;

  constructor(private readonly locks: LockManager = navigator.locks) {}

  reserveStart(): () => void {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.starts.add(pending);
    return () => {
      this.starts.delete(pending);
      finish();
    };
  }

  acquire(mode: WorkspaceMode): Promise<boolean> {
    return this.acquireLease(mode);
  }

  private acquireLease(
    mode: WorkspaceMode,
    maintenance = false,
  ): Promise<boolean> {
    const acquisition = this.acquisition.then(async () => {
      if (this.draining || (this.maintaining && !maintenance)) return false;
      if (this.mode) return this.mode === mode;
      if (!this.locks)
        throw new Error(
          '当前浏览器不支持工作区锁，请使用支持 Web Locks 的浏览器',
        );

      return new Promise<boolean>((resolve, reject) => {
        this.lease = this.locks.request(
          'auto-novel:gpt-beta-execution',
          { mode: 'exclusive', ifAvailable: true },
          async (lock) => {
            if (!lock) {
              resolve(false);
              return;
            }
            this.mode = mode;
            const held = new Promise<void>((done) => {
              this.release = done;
            });
            resolve(true);
            await held;
          },
        );
        this.lease.catch(reject);
      });
    });
    this.acquisition = acquisition.then(
      () => {},
      () => {},
    );
    return acquisition;
  }

  releaseWhenIdle(
    mode: WorkspaceMode,
    drain: Promise<unknown>,
    isIdle = () => true,
  ): Promise<boolean> {
    if (this.mode !== mode) return Promise.resolve(false);
    if (this.drainingPromise) return this.drainingPromise;
    this.draining = true;
    // Observe rejection immediately, including while admitted starts finish.
    const settled = Promise.allSettled([drain]);
    this.drainingPromise = (async () => {
      let releaseLease = true;
      try {
        await Promise.all([...this.starts]);
        releaseLease = isIdle();
        if (!releaseLease) return false;
        const [result] = await settled;
        if (result.status === 'rejected') throw result.reason;
        return true;
      } finally {
        if (releaseLease) {
          this.release?.();
          await this.lease;
          this.mode = undefined;
          this.release = undefined;
          this.lease = undefined;
        }
        this.draining = false;
        this.drainingPromise = undefined;
      }
    })();
    return this.drainingPromise;
  }

  async runMaintenance(
    mode: WorkspaceMode,
    operation: () => Promise<void>,
  ): Promise<boolean> {
    if (this.maintaining || this.starts.size) return false;
    this.maintaining = true;
    try {
      if (!(await this.acquireLease(mode, true))) return false;
      await operation();
      return true;
    } finally {
      try {
        await this.releaseWhenIdle(mode, Promise.resolve());
      } finally {
        this.maintaining = false;
      }
    }
  }
}

/** Chapter promises can settle before canceled legacy model requests clean up. */
export async function waitForLegacyDrain(
  startups: Promise<unknown>,
  chapters: () => Promise<unknown> | null,
  activeRequests: () => number,
): Promise<void> {
  await startups;
  const [result] = await Promise.allSettled([chapters()]);
  if (activeRequests() > 0) {
    await new Promise<void>((resolve) => {
      const stop = watch(
        activeRequests,
        (count) => {
          if (count === 0) {
            stop();
            resolve();
          }
        },
        { flush: 'sync' },
      );
    });
  }
  if (result.status === 'rejected') throw result.reason;
}
