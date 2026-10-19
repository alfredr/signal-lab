// Decodes audio files and microphone recordings, stores them in IndexedDB, and
// embeds them in exported documents. Recordings are mixed to mono and
// peak-normalized.

export type Clip = {
  readonly id: string;
  /** The file it came from, or when it was recorded. */
  readonly name: string;
  readonly rate: number;
  readonly data: Float32Array;
};

/** The rate recordings are decoded at, the usual rate of audio hardware. */
const RATE = 48000;
/** The longest recording kept, in seconds. */
export const LONGEST = 30;

const cache = new Map<string, Clip>();

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('signal-lab', 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore('clips', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB'));
  });
}

async function store<T>(
  mode: IDBTransactionMode,
  use: (clips: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = use(db.transaction('clips', mode).objectStore('clips'));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB'));
  });
}

/** Keeps a recording in this browser. */
export async function putClip(clip: Clip): Promise<void> {
  cache.set(clip.id, clip);

  try {
    await store('readwrite', (clips) => clips.put(clip));
  } catch {
    // Private windows may refuse; the recording still works until reload.
  }
}

/** A recording kept in this browser, if there is one. */
export async function getClip(id: string): Promise<Clip | undefined> {
  const cached = cache.get(id);
  if (cached) {
    return cached;
  }

  try {
    const clip = await store<Clip | undefined>('readonly', (clips) =>
      clips.get(id),
    );
    if (clip) {
      cache.set(id, clip);
    }

    return clip;
  } catch {
    return undefined;
  }
}

/** A recording if it has already been read, for showing its name. */
export function cachedClip(id: string): Clip | undefined {
  return cache.get(id);
}

const newId = () =>
  `clip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Decodes a browser-supported audio file, mixes it to mono, truncates it to
 * `LONGEST` seconds, and normalizes its peak to 1.
 */
export async function decodeClip(
  bytes: ArrayBuffer,
  name: string,
): Promise<Clip> {
  const context = new OfflineAudioContext(1, 1, RATE);
  const buffer = await context.decodeAudioData(bytes);
  const length = Math.min(buffer.length, LONGEST * RATE);
  const data = new Float32Array(length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const channel = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) {
      data[i] += channel[i] / buffer.numberOfChannels;
    }
  }

  let peak = 0;
  for (let i = 0; i < length; i++) {
    peak = Math.max(peak, Math.abs(data[i]));
  }

  if (peak > 0) {
    for (let i = 0; i < length; i++) {
      data[i] /= peak;
    }
  }

  return { id: newId(), name, rate: RATE, data };
}

/** A recording being made from the microphone. */
export type Recorder = {
  /** Stops and decodes what was recorded. */
  stop(): Promise<Clip>;
  /** Stops and throws it away. */
  cancel(): void;
};

/** Starts recording from the microphone, asking permission the first time. */
export async function recordMicrophone(): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const recorder = new MediaRecorder(stream);
  const parts: Blob[] = [];
  recorder.addEventListener('dataavailable', (event) =>
    parts.push(event.data),
  );
  const finished = new Promise<void>((resolve) =>
    recorder.addEventListener('stop', () => resolve()),
  );
  const started = new Date();
  recorder.start();

  const release = () => {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  };

  // Recordings stop on their own at the longest kept.
  const limit = setTimeout(() => recorder.stop(), LONGEST * 1000);
  return {
    async stop() {
      clearTimeout(limit);

      if (recorder.state !== 'inactive') {
        recorder.stop();
      }

      await finished;
      release();
      const bytes = await new Blob(parts).arrayBuffer();
      return decodeClip(
        bytes,
        `Recorded ${started.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
      );
    },
    cancel() {
      clearTimeout(limit);

      if (recorder.state !== 'inactive') {
        recorder.stop();
      }

      release();
    },
  };
}

/** A recording as it is saved in a file: 16-bit samples in base64. */
export type SavedClip = {
  readonly name: string;
  readonly rate: number;
  readonly samples: string;
};

export function packClip(clip: Clip): SavedClip {
  const bytes = new Uint8Array(clip.data.length * 2);
  const view = new DataView(bytes.buffer);
  clip.data.forEach((v, i) =>
    view.setInt16(
      2 * i,
      Math.round(Math.max(-1, Math.min(1, v)) * 32767),
      true,
    ),
  );
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }

  return { name: clip.name, rate: clip.rate, samples: btoa(text) };
}

/** A recording from a saved file, if it reads as one. */
export function unpackClip(id: string, value: unknown): Clip | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const { name, rate, samples } = value as Record<string, unknown>;
  if (typeof samples !== 'string' || typeof rate !== 'number' || !(rate > 0)) {
    return undefined;
  }

  try {
    const text = atob(samples);
    const view = new DataView(new ArrayBuffer(text.length));
    for (let i = 0; i < text.length; i++) {
      view.setUint8(i, text.charCodeAt(i));
    }

    const data = new Float32Array(Math.floor(text.length / 2));
    for (let i = 0; i < data.length; i++) {
      data[i] = view.getInt16(2 * i, true) / 32767;
    }

    return {
      id,
      name: typeof name === 'string' ? name : 'Recording',
      rate,
      data,
    };
  } catch {
    return undefined;
  }
}
