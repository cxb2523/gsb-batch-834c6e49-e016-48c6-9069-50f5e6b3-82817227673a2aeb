import { describe, expect, it, vi } from "vitest";

// Прогоняет сгенерированный исходник процессора так, как это сделал бы AudioWorklet
const { modules, blobs } = vi.hoisted(() => ({
  modules: [] as string[],
  blobs: new Map<string, Blob>(),
}));

vi.mock('../ctx', () => ({
  ctx: {
    sampleRate: 1000,
    audioWorklet: {
      addModule: async (url: string) => {
        modules.push(await blobs.get(url)!.text());
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
vi.stubGlobal('AudioWorkletNode', class { });

type Processor = {
  context: any;
  props: any;
  port: { onmessage: (e: { data: any; }) => void; };
  process(inputs: any[], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
};

const load = async (module: () => Promise<unknown>) => {
  modules.length = 0;
  await module();

  var Processor: (new () => Processor) & { parameterDescriptors: { name: string, defaultValue: number; }[]; } = null!;

  new Function('registerProcessor', 'AudioWorkletProcessor', modules[0])(
    (_name: string, cls: typeof Processor) => Processor = cls,
    class { port = { onmessage: null }; }
  );

  return () => {
    const processor = new Processor();

    // Обрабатывает блок: значения параметров по сэмплам, неуказанные — по умолчанию
    const run = (frames: number, params: Record<string, number[] | number> = {}) => {
      const out = new Float32Array(frames);
      const parameters: Record<string, Float32Array> = {};

      // Как в браузере: каждый параметр есть, по умолчанию — defaultValue
      for (const { name, defaultValue } of Processor.parameterDescriptors)
        parameters[name] = new Float32Array([defaultValue]);

      for (const [key, value] of Object.entries(params))
        parameters[key] = typeof value === 'number' ? new Float32Array([value]) : new Float32Array(value);

      processor.process([], [[out]], parameters);
      return [...out];
    };

    return { processor, run };
  };
};

const smoothing = await load(() => import('./SmoothingProcessor'));

const round = (values: number[]) => values.map(v => +v.toFixed(5));

describe('Smoothing worklet', () => {
  it('eases from the previous output toward the new value over the frame count', () => {
    const { run } = smoothing();
    // value 0 -> 100 за 4 кадра, линейно
    const out = run(4, { value: 100, frames: 4 });

    expect(round(out)).toEqual([25, 50, 75, 100]);
  });

  it('keeps the settled value and does not drift after the transition ends', () => {
    const { run } = smoothing();
    run(4, { value: 100, frames: 4 });
    const out = run(3, { value: 100, frames: 4 });

    expect(round(out)).toEqual([100, 100, 100]);
  });

  it('passes the input straight through when frames <= 1', () => {
    const { run } = smoothing();

    expect(run(3, { value: 42, frames: 1 })).toEqual([42, 42, 42]);
    expect(run(3, { value: 42, frames: 0 })).toEqual([42, 42, 42]);
    expect(run(3, { value: 42, frames: -5 })).toEqual([42, 42, 42]);
  });

  it('passes the input straight through for an unknown curve without throwing', () => {
    const { processor, run } = smoothing();
    processor.props.type = 'does-not-exist';

    expect(() => run(4, { value: 7, frames: 10 })).not.toThrow();
    expect(run(4, { value: 7, frames: 10 })).toEqual([7, 7, 7, 7]);

    // после возврата валидной кривой переход снова работает:
    // на выходе было 7 (прямой проход), к новой цели 11 идём от 7 за 4 кадра
    processor.props.type = 'linear';
    expect(round(run(4, { value: 11, frames: 4 }))).toEqual([8, 9, 10, 11]);
  });

  it('switches curve mid-transition from the current output without a jump or restart', () => {
    const { processor, run } = smoothing();

    // 0 -> 100, линейно, 4 кадра; за первый блок доходим до 50 (доля 0.5)
    expect(round(run(2, { value: 100, frames: 4 }))).toEqual([25, 50]);

    // меняем кривую, цель и длительность не трогаем
    processor.props.type = 'easeInQuad';
    const out = run(4, { value: 100, frames: 4 });

    // Первый сэмпл обязан продолжить с текущего значения 50 без скачка:
    // новая кривая стартует с from = 50, t = 1/4 -> 50 + 50 * 0.0625 = 53.125
    expect(out[0]).toBeCloseTo(53.125, 5);
    expect(out[0]).toBeGreaterThanOrEqual(50 - 1e-9);
    // и приходит в ту же цель 100
    expect(out[3]).toBeCloseTo(100, 5);
    // никакой откат к стартовому from=0
    expect(out[0]).not.toBeCloseTo(6.25, 4);
  });

  it('recalculates the remaining progress when frames change mid-transition, keeping the covered ratio', () => {
    const { run } = smoothing();

    // 0 -> 100 за 4 кадра, прошли 2 кадра (доля 0.5), выход 50
    expect(round(run(2, { value: 100, frames: 4 }))).toEqual([25, 50]);

    // удлиняем переход до 8 кадров: доля 0.5 сохраняется -> times=4,
    // следующий сэмпл t=5/8=0.625
    const longer = run(1, { value: 100, frames: 8 });
    expect(longer[0]).toBeCloseTo(62.5, 5);
    // без скачка: значение продолжает расти с 50
    expect(longer[0]).toBeGreaterThan(50);

    // укорачиваем на ходу до 4 кадров при текущей доле 5/8: times = 5/8*4 = 2.5
    const shorter = run(1, { value: 100, frames: 4 });
    // следующий сэмпл: times 3.5 -> t=0.875
    expect(shorter[0]).toBeCloseTo(87.5, 5);
  });

  it('restarts the timing from the current output when the input changes mid-transition', () => {
    const { run } = smoothing();

    // 0 -> 100 за 4 кадра, дошли до 50
    expect(round(run(2, { value: 100, frames: 4 }))).toEqual([25, 50]);

    // новая цель 200: старт от текущего выхода 50, новый отсчёт с нуля, 4 кадра
    const out = run(4, { value: 200, frames: 4 });
    // t=1/4 -> 50 + 150*0.25 = 87.5 ... 100% -> 200
    expect(round(out)).toEqual([87.5, 125, 162.5, 200]);
  });

  it('clears the interpolation context on [RESET] so a pooled processor starts clean', () => {
    const { processor, run } = smoothing();

    // накапливаем нетривиальное состояние перехода
    run(2, { value: 100, frames: 4 });
    expect(processor.context.toValue).toBe(100);
    expect(processor.context.times).toBe(2);
    expect(processor.context.previewValue).toBe(50);

    // это сообщение шлёт CustomAudioWorkletNode.destroy() при возврате экземпляра в пул
    processor.port.onmessage({ data: '[RESET]' });

    expect(processor.context.fromValue).toBe(0);
    expect(processor.context.toValue).toBe(0);
    expect(processor.context.previewValue).toBe(0);
    expect(processor.context.times).toBe(0);
    expect(processor.context.type).toBe('linear');
    expect(processor.context.frames).toBe(1000);

    // повторное использование из пула: переход стартует с нуля, а не с чужих from/to/times
    const out = run(4, { value: 80, frames: 4 });
    expect(round(out)).toEqual([20, 40, 60, 80]);
  });

  it('a reused (destroyed then re-created) processor does not inherit the previous transition', () => {
    const { processor, run } = smoothing();

    // первый узел: незавершённый переход 0 -> 100
    run(3, { value: 100, frames: 8 });
    const before = { ...processor.context };

    // уничтожение узла (пул): reset контекста и сброс параметров на defaultValue
    processor.port.onmessage({ data: '[RESET]' });

    // новый узел получает процессор из пула; вход по умолчанию value=0, frames=1000
    const out = run(2, {});
    // чистый старт: никаких остаточных from=0/to=100/times=3 — выход остаётся на 0
    expect(out).toEqual([0, 0]);
    expect(processor.context.toValue).not.toBe(before.toValue);
  });
});
