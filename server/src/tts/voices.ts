/** The voice library: Kokoro's English voices with tags for casting. */
export interface Voice {
  id: string;
  name: string;
  gender: 'male' | 'female';
  accent: 'us' | 'gb';
  tags: string[];
  /** Kokoro's own quality grade; better voices are cast first. */
  grade: string;
}

const V = (id: string, name: string, grade: string, tags: string[] = []): Voice => ({
  id,
  name,
  gender: id[1] === 'f' ? 'female' : 'male',
  accent: id[0] === 'b' ? 'gb' : 'us',
  tags,
  grade,
});

export const VOICES: Voice[] = [
  V('af_heart', 'Heart', 'A', ['warm', 'adult', 'narrator']),
  V('af_bella', 'Bella', 'A-', ['bright', 'young', 'narrator']),
  V('af_nicole', 'Nicole', 'B-', ['whisper', 'soft', 'adult']),
  V('af_aoede', 'Aoede', 'C+', ['adult']),
  V('af_kore', 'Kore', 'C+', ['adult', 'stern']),
  V('af_sarah', 'Sarah', 'C+', ['adult']),
  V('af_nova', 'Nova', 'C', ['young']),
  V('af_alloy', 'Alloy', 'C', ['adult']),
  V('af_sky', 'Sky', 'C-', ['young', 'child']),
  V('af_jessica', 'Jessica', 'D', ['young']),
  V('af_river', 'River', 'D', ['young', 'child']),
  V('am_fenrir', 'Fenrir', 'C+', ['rough', 'deep', 'adult']),
  V('am_michael', 'Michael', 'C+', ['adult', 'narrator']),
  V('am_puck', 'Puck', 'C+', ['young', 'trickster']),
  V('am_echo', 'Echo', 'D', ['adult']),
  V('am_eric', 'Eric', 'D', ['adult']),
  V('am_liam', 'Liam', 'D', ['young']),
  V('am_onyx', 'Onyx', 'D', ['deep', 'rough']),
  V('am_santa', 'Santa', 'D-', ['old', 'jolly']),
  V('am_adam', 'Adam', 'F+', ['adult']),
  V('bf_emma', 'Emma', 'B-', ['adult', 'mature', 'narrator']),
  V('bf_isabella', 'Isabella', 'C', ['adult']),
  V('bf_alice', 'Alice', 'D', ['young']),
  V('bf_lily', 'Lily', 'D', ['young', 'child']),
  V('bm_george', 'George', 'C', ['old', 'mature', 'narrator']),
  V('bm_fable', 'Fable', 'C', ['storyteller', 'adult', 'narrator']),
  V('bm_lewis', 'Lewis', 'D+', ['adult', 'deep']),
  V('bm_daniel', 'Daniel', 'D', ['young']),
];

export const DEFAULT_NARRATOR = 'bm_fable';
export const voiceById = (id: string | undefined) => VOICES.find((v) => v.id === id);

/** Sound effects for voices (ffmpeg filters, see fx.ts). */
export const FX = ['none', 'monster', 'giant', 'small', 'ghost', 'radio'] as const;
export type Fx = (typeof FX)[number];
