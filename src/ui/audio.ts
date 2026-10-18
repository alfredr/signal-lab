// Listening to any signal in the diagram. Playback loops, and when the simulation produces a
// new version of the signal being played it is swapped in at the same point in the loop, so
// knob changes are heard as they happen.

import { downsample, upsample } from '../dsp/resample.ts';
import type { Signal } from '../engine/signal.ts';

/** Sample rates every browser's AudioBuffer accepts. */
const LOWEST_RATE = 8000;
const HIGHEST_RATE = 96000;
const FADE_SECONDS = 0.03;

type Voice = {
  readonly key: string;
  readonly data: Float32Array;
  readonly source: AudioBufferSourceNode;
  readonly gain: GainNode;
  readonly startedAt: number;
  readonly duration: number;
};

/**
 * The signal at a rate the browser can play: resampled by a whole factor if it
 * is out of range.
 */
function playable(signal: Signal): Signal {
  if (signal.rate > HIGHEST_RATE) {
    const factor = Math.ceil(signal.rate / HIGHEST_RATE);
    const data = new Float32Array(Math.floor(signal.data.length / factor));
    downsample(signal.data, factor, data);
    return { rate: signal.rate / factor, data };
  }

  if (signal.rate < LOWEST_RATE) {
    const factor = Math.ceil(LOWEST_RATE / signal.rate);
    const data = new Float32Array(signal.data.length * factor);
    upsample(signal.data, factor, data);
    return { rate: signal.rate * factor, data };
  }

  return signal;
}

/**
 * An audio buffer for the signal at a comfortable level: scaled up or down to
 * a steady loudness, with peaks rounded off by tanh and short fades at the
 * ends so the loop doesn't click.
 */
function toBuffer(context: AudioContext, signal: Signal): AudioBuffer {
  const { data, rate } = playable(signal);
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    peak = Math.max(peak, Math.abs(data[i]));
    sum += data[i] * data[i];
  }

  const rms = Math.sqrt(sum / Math.max(1, data.length));
  const gain = peak > 0 ? Math.min(0.8 / peak, 0.25 / rms) : 0;
  const buffer = context.createBuffer(1, Math.max(1, data.length), rate);
  const channel = buffer.getChannelData(0);
  const fade = Math.min(Math.round(0.01 * rate), Math.floor(data.length / 2));
  for (let i = 0; i < data.length; i++) {
    const edge = Math.min(
      1,
      i / Math.max(1, fade),
      (data.length - 1 - i) / Math.max(1, fade),
    );
    channel[i] = Math.tanh(data[i] * gain) * edge;
  }

  return buffer;
}

export class Player {
  #context: AudioContext | undefined;
  #voice: Voice | undefined;
  readonly #listeners = new Set<() => void>();

  /** Key of the port being played, if any. */
  get playing(): string | undefined {
    return this.#voice?.key;
  }

  /**
   * Where playback is in the signal, in seconds, for the playhead to follow;
   * undefined when nothing plays.
   */
  position(): number | undefined {
    const voice = this.#voice;
    if (!voice || !this.#context || voice.duration <= 0) {
      return undefined;
    }

    return (this.#context.currentTime - voice.startedAt) % voice.duration;
  }

  play(key: string, signal: Signal): void {
    this.#start(key, signal, 0);
    this.#notify();
  }

  stop(): void {
    this.#fadeOut(this.#voice);
    this.#voice = undefined;
    this.#notify();
  }

  /**
   * Swaps in the latest version of the signal being played; stops if it no
   * longer exists.
   */
  refresh(signal: Signal | undefined): void {
    const voice = this.#voice;
    if (!voice || voice.data === signal?.data) {
      return;
    }

    if (!signal) {
      this.stop();
      return;
    }

    const context = this.#ensureContext();
    const elapsed = context.currentTime - voice.startedAt;
    this.#start(
      voice.key,
      signal,
      voice.duration > 0 ? elapsed % voice.duration : 0,
    );
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #ensureContext(): AudioContext {
    this.#context ??= new AudioContext();

    if (this.#context.state === 'suspended') {
      void this.#context.resume();
    }

    return this.#context;
  }

  #start(key: string, signal: Signal, offset: number): void {
    const context = this.#ensureContext();
    const buffer = toBuffer(context, signal);
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    source.loop = true;
    source.connect(gain).connect(context.destination);
    const now = context.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + FADE_SECONDS);
    const position = buffer.duration > 0 ? offset % buffer.duration : 0;
    source.start(now, position);
    this.#fadeOut(this.#voice);
    this.#voice = {
      key,
      data: signal.data,
      source,
      gain,
      startedAt: now - position,
      duration: buffer.duration,
    };
  }

  #fadeOut(voice: Voice | undefined): void {
    if (!voice || !this.#context) {
      return;
    }

    const now = this.#context.currentTime;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
    voice.gain.gain.linearRampToValueAtTime(0, now + FADE_SECONDS);
    voice.source.stop(now + FADE_SECONDS + 0.01);
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
