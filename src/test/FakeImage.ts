/**
 * Deterministic Image double for preload tests: jsdom never fires `load`
 * itself, so tests trigger it manually and can inspect released instances.
 */
export class FakeImage {
  static instances: FakeImage[] = [];
  private static originalImage?: typeof Image;

  static reset(): void {
    FakeImage.instances = [];
  }

  static install(): void {
    FakeImage.reset();
    FakeImage.originalImage = globalThis.Image;
    globalThis.Image = FakeImage as unknown as typeof Image;
  }

  static restore(): void {
    FakeImage.reset();
    if (FakeImage.originalImage) {
      globalThis.Image = FakeImage.originalImage;
      FakeImage.originalImage = undefined;
    }
  }

  static getBySrc(src: string): FakeImage | undefined {
    return FakeImage.instances.find((image) => image.src === src);
  }

  /** Instances whose `src` was cleared when their set was released. */
  static getReleased(): FakeImage[] {
    return FakeImage.instances.filter((image) => image.src === '');
  }

  private readonly listeners: Record<string, EventListener> = {};
  private _src = '';

  constructor() {
    FakeImage.instances.push(this);
  }

  get src(): string {
    return this._src;
  }

  set src(value: string) {
    this._src = value;
  }

  addEventListener(type: string, listener: EventListener): void {
    this.listeners[type] = listener;
  }

  removeEventListener(type: string, listener: EventListener): void {
    if (this.listeners[type] === listener) {
      delete this.listeners[type];
    }
  }

  load(): void {
    this.listeners.load?.({ type: 'load' } as Event);
  }
}
