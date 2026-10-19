// Listening to the stream. A port being listened to plays as the stream
// reaches it: each new stretch is resampled to the audio device's rate and
// scheduled right after the last, so the sound runs on without gaps, and while
// anything plays the playhead follows the audio clock. It plays at the
// stream's speed the way a tape does, so at an eighth of the speed it sounds
// three octaves lower. Turning a speaker on or off only connects or
// disconnects it: time goes on either way. Levels ride a slow automatic gain,
// so a whisper and a carrier are both comfortable, with peaks rounded off by
// tanh.

import { Interpolator } from '../dsp/resample.ts';
import type { Trace } from './live.ts';

/** Seconds of sound scheduled ahead of the audio clock, at most. */
const AHEAD = 0.4;
/** The earliest a new sound can start, in seconds from now. */
const MARGIN = 0.05;
/** The shortest stretch worth scheduling on its own, in seconds. */
const SHORTEST = 0.02;
const FADE = 0.03;

type Anchor = {
  readonly audio: number;
  readonly stream: number;
  readonly speed: number;
};

type Voice = {
  readonly gain: GainNode;
  /** Sounds scheduled and not yet over. */
  readonly sources: Set<AudioBufferSourceNode>;
  /** The next audio frame to schedule, counted from the anchor. */
  frame: number;
  /** The automatic gain, 0 until it has heard something. */
  level: number;
};

export class Monitor {
  #context: AudioContext | undefined;
  readonly #voices = new Map<string, Voice>();
  /**
   * Readers that filter out what the speaker can't play before it folds back:
   * a long kernel, and a shorter one for reading very sparsely, as a fast tape
   * of a radio-frequency signal does, where the long one costs too much.
   */
  readonly #fine = new Interpolator(8);
  readonly #coarse = new Interpolator(4);
  /**
   * While sound runs, audio time `audio` plays stream time `stream`, and each
   * second of audio plays `speed` seconds of stream.
   */
  #anchor: Anchor | undefined;
  readonly #listeners = new Set<() => void>();

  /** Port keys being listened to. */
  get listening(): ReadonlySet<string> {
    return new Set(this.#voices.keys());
  }

  /** Starts or stops listening to a port. */
  toggle(key: string): void {
    const voice = this.#voices.get(key);
    if (voice) {
      this.#silence(voice);
      this.#voices.delete(key);
    } else {
      const context = this.#ensureContext();
      const gain = context.createGain();
      gain.connect(context.destination);
      this.#voices.set(key, {
        gain,
        sources: new Set(),
        frame: this.#soonest(),
        level: 0,
      });
    }

    if (!this.#voices.size) {
      this.#anchor = undefined;
    }

    this.#notify();
  }

  /** Stops listening to everything. */
  clear(): void {
    for (const key of [...this.#voices.keys()]) {
      this.toggle(key);
    }
  }

  /** The stream time the audio clock says it is, while sound runs. */
  clock(): number | undefined {
    const context = this.#context;
    const anchor = this.#anchor;
    return anchor && context
      ? anchor.stream + (context.currentTime - anchor.audio) * anchor.speed
      : undefined;
  }

  /**
   * Keeps the sound going: schedules what has arrived of each port listened
   * to, from playhead time `t` on at `speed` while `running`, and falls silent
   * otherwise. A new speed starts the sound again from `t`.
   */
  feed(
    traces: ReadonlyMap<string, Trace>,
    t: number,
    running: boolean,
    speed: number,
  ): void {
    const context = this.#context;
    if (!running || !this.#voices.size || context?.state !== 'running') {
      this.halt();
      return;
    }

    if (this.#anchor && this.#anchor.speed !== speed) {
      this.halt();
    }

    if (!this.#anchor) {
      this.#anchor = { audio: context.currentTime, stream: t, speed };

      for (const voice of this.#voices.values()) {
        const now = context.currentTime;
        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setValueAtTime(0, now);
        voice.gain.gain.linearRampToValueAtTime(1, now + FADE);
        voice.frame = this.#soonest();
      }
    }

    for (const [key, voice] of this.#voices) {
      const trace = traces.get(key);
      if (trace) {
        this.#schedule(context, this.#anchor, voice, trace);
      }
    }
  }

  /** Stops the sound, keeping the ports listened to for when it starts again. */
  halt(): void {
    if (!this.#anchor) {
      return;
    }

    this.#anchor = undefined;

    for (const voice of this.#voices.values()) {
      this.#silence(voice);
    }
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The first frame that can still start in time. */
  #soonest(): number {
    const context = this.#context;
    const anchor = this.#anchor;
    return context && anchor
      ? Math.ceil(
          (context.currentTime + MARGIN - anchor.audio) * context.sampleRate,
        )
      : 0;
  }

  #schedule(
    context: AudioContext,
    anchor: Anchor,
    voice: Voice,
    trace: Trace,
  ): void {
    const out = context.sampleRate;
    const rate = trace.rate;
    // Samples of the stream per frame of sound.
    const ratio = (rate * anchor.speed) / out;
    const reader = ratio > 16 ? this.#coarse : this.#fine;
    const reach = reader.reach(ratio);
    voice.frame = Math.max(voice.frame, this.#soonest());
    // As far as the clock allows, and as far as there are samples to read.
    const last = Math.min(
      Math.floor((context.currentTime + AHEAD - anchor.audio) * out),
      Math.floor(
        (((trace.end - reach - 1) / rate - anchor.stream) / anchor.speed) *
          out,
      ),
    );
    const frames = last - voice.frame;
    if (frames < SHORTEST * out) {
      return;
    }

    // Where in the stream each frame plays, in samples.
    const at = (frame: number) =>
      (anchor.stream + (frame / out) * anchor.speed) * rate;
    const first = Math.floor(at(voice.frame)) - reach;
    const samples = trace.read(first, Math.ceil(at(last)) + reach + 1);
    const buffer = context.createBuffer(1, frames, out);
    const channel = buffer.getChannelData(0);
    for (let k = 0; k < frames; k++) {
      channel[k] = reader.at(samples, at(voice.frame + k) - first, ratio);
    }

    // The level is set by the signal on the wire, not by what is left of it
    // to hear, so a carrier far above hearing plays as near silence rather
    // than having its faint remains turned up.
    let peak = 0;
    let sum = 0;
    for (let i = reach; i < samples.length - reach; i++) {
      peak = Math.max(peak, Math.abs(samples[i]!));
      sum += samples[i]! * samples[i]!;
    }

    const rms = Math.sqrt(sum / Math.max(1, samples.length - 2 * reach));
    if (peak > 0) {
      const wanted = Math.min(0.8 / peak, 0.25 / rms);
      // Quick to duck under something loud, slow to bring the level back up.
      voice.level =
        voice.level === 0 || voice.level * peak > 1.5
          ? wanted
          : voice.level + (wanted - voice.level) * 0.1;
    }

    for (let k = 0; k < frames; k++) {
      channel[k] = Math.tanh(channel[k] * voice.level);
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(voice.gain);
    source.addEventListener('ended', () => voice.sources.delete(source));
    source.start(anchor.audio + voice.frame / out);
    voice.sources.add(source);
    voice.frame = last;
  }

  /** Fades a voice out and drops what it had scheduled. */
  #silence(voice: Voice): void {
    const context = this.#context;
    if (!context) {
      return;
    }

    const now = context.currentTime;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
    voice.gain.gain.linearRampToValueAtTime(0, now + FADE);

    for (const source of voice.sources) {
      source.stop(now + FADE + 0.01);
    }

    voice.sources.clear();
  }

  #ensureContext(): AudioContext {
    this.#context ??= new AudioContext();

    if (this.#context.state === 'suspended') {
      void this.#context.resume();
    }

    return this.#context;
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
