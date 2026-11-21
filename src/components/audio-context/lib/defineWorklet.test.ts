import { describe, expect, it, vi } from "vitest";

const { modules, blobs, registered } = vi.hoisted(() => ({
  modules: [] as string[],
  blobs: new Map<string, Blob>(),
  registered: new Map<string, { name: string; defaultValue: number; }[]>(),
}));

vi.mock('../ctx', () => ({
  ctx: {
    sampleRate: 48000,
    audioWorklet: {
      addModule: async (url: string) => {
        const code = await blobs.get(url)!.text();
        modules.push(code);
        // Вытаскиваем дескрипторы параметров так же, как их объявляет процессор
        new Function('registerProcessor', 'AudioWorkletProcessor', code)(
          (name: string, cls: { parameterDescriptors: { name: string; defaultValue: number; }[]; }) => {
            registered.set(name, cls.parameterDescriptors);
          },
          class { }
        );
      }
    }
  },
}));

vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
  const url = `blob:test/${blobs.size}`;
  blobs.set(url, blob as Blob);
  return url;
});
vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => { });

// Минимальный двойник AudioWorkletNode: параметры как AudioParam и порт с очередью сообщений
class MockAudioParam {
  value: number;
  readonly defaultValue: number;

  constructor(defaultValue: number) {
    this.defaultValue = defaultValue;
    this.value = defaultValue;
  }
}

const posted: any[] = [];
let lastProcessorName = '';

vi.stubGlobal('AudioWorkletNode', class MockAudioWorkletNode {
  parameters = new Map<string, MockAudioParam>();
  port = {
    postMessage: (data: any) => posted.push(data),
  };

  constructor(_ctx: unknown, processorName: string, options?: { parameterData?: Record<string, number>; }) {
    lastProcessorName = processorName;
    // Браузер заводит AudioParam по дескрипторам; parameterData переопределяет стартовое значение
    for (const desc of registered.get(processorName) ?? []) {
      const initial = options?.parameterData?.[desc.name] ?? desc.defaultValue;
      this.parameters.set(desc.name, new MockAudioParam(desc.defaultValue));
      this.parameters.get(desc.name)!.value = initial;
    }
  }
});

const { defineWorklet } = await import('./defineWorklet');

const make = () => defineWorklet({
  name: 'PoolProbe',
  params: {
    value: { defaultValue: 0 },
    frames: { defaultValue: 1000 },
  },
  props: { type: 'linear' } as { type: string },
  context: { fromValue: 0, toValue: 0, previewValue: 0, times: 0, type: 'linear', frames: 1000 },
  loop() { },
});

describe('defineWorklet pool reuse', () => {
  it('returns a destroyed instance from the pool with reset params, props and a [RESET] message', async () => {
    const Node = await make();

    const first = new Node({ value: 5, frames: 10 });
    expect(lastProcessorName).toBeTruthy();
    expect(first).toBeInstanceOf(Node);
    expect(first.value.value).toBe(5);
    expect(first.frames.value).toBe(10);

    first.value.value = 99;
    first.frames.value = 250;
    first.props.type = 'easeInQuad';

    posted.length = 0;
    first.destroy();

    // в worklet улетел сброс контекста, а проп сброшен на дефолт
    expect(posted).toContain('[RESET]');
    expect(posted).toContainEqual({ key: 'type', value: 'linear' });
    expect(first.props.type).toBe('linear');

    // параметры возвращены к defaultValue
    expect(first.value.value).toBe(0);
    expect(first.frames.value).toBe(1000);

    // повторное создание забирает тот же экземпляр из пула, а не строит новый
    const second = new Node();
    expect(second).toBe(first);
    expect(second.props.type).toBe('linear');
  });

  it('does not hand out one pooled instance twice', async () => {
    const Node = await make();

    const a = new Node();
    a.destroy();
    const b = new Node(); // забирает единственный элемент пула
    const c = new Node(); // пул пуст -> свежий экземпляр

    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });
});
