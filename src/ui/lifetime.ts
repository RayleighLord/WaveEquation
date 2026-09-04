/** Own browser work so teardown also cancels callbacks queued between frames. */
export class AppLifetime {
  private readonly abort = new AbortController();
  private readonly frames = new Set<number>();
  private readonly timers = new Set<number>();
  private disposed = false;

  on<K extends keyof GlobalEventHandlersEventMap>(
    target: EventTarget,
    type: K,
    listener: (event: GlobalEventHandlersEventMap[K]) => void
  ): void;
  on(target: Document, type: "visibilitychange", listener: (event: Event) => void): void;
  on(target: Window, type: "beforeunload", listener: (event: BeforeUnloadEvent) => void): void;
  on(target: EventTarget, type: string, listener: (event: never) => void): void {
    target.addEventListener(type, listener as EventListener, { signal: this.abort.signal });
  }

  frame(callback: FrameRequestCallback): number {
    if (this.disposed) return 0;
    const id = window.requestAnimationFrame((time) => {
      this.frames.delete(id);
      if (!this.disposed) callback(time);
    });
    this.frames.add(id);
    return id;
  }

  cancelFrame(id: number): void {
    window.cancelAnimationFrame(id);
    this.frames.delete(id);
  }

  timeout(callback: () => void, delay: number): number {
    if (this.disposed) return 0;
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      if (!this.disposed) callback();
    }, delay);
    this.timers.add(id);
    return id;
  }

  cancelTimeout(id: number): void {
    window.clearTimeout(id);
    this.timers.delete(id);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    for (const id of this.frames) window.cancelAnimationFrame(id);
    for (const id of this.timers) window.clearTimeout(id);
    this.frames.clear();
    this.timers.clear();
  }
}
