// Thin wrapper over the browser-native Web Speech API (SpeechRecognition).
// Site-agnostic: no site- or task-specific logic. Two shapes are exposed:
//  - a one-shot "dictation" recognizer (chat input / push-to-talk guidance)
//  - a "continuous" recognizer (hands-free narration while recording)
// The API is Chrome-only and streams audio to the browser's speech service; all
// callers must feature-detect via isSpeechSupported() and gate on a user setting.

/* eslint-disable @typescript-eslint/no-explicit-any */

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
}

function getCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as any;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as
    | (new () => SpeechRecognitionLike)
    | null;
}

export function isSpeechSupported(): boolean {
  return getCtor() != null;
}

export interface SpeechSession {
  /** Stop gracefully (fires any pending final result, then onend). */
  stop(): void;
  /** True while the recognizer is meant to be listening. */
  isActive(): boolean;
}

export interface DictationOptions {
  lang?: string;
  /** Interim (not-yet-final) transcript for live on-screen feedback. */
  onInterim?: (text: string) => void;
  /** A finalized transcript segment. */
  onFinal?: (text: string) => void;
  /** Recognition ended (naturally or via stop()). */
  onEnd?: () => void;
  onError?: (error: string) => void;
}

/**
 * A single dictation pass: listens until the user stops or a natural pause ends
 * it. Interim results stream via onInterim; the accumulated final text streams
 * via onFinal. Used for the chat mic and push-to-talk guidance.
 */
export function createDictation(opts: DictationOptions): SpeechSession | null {
  const Ctor = getCtor();
  if (!Ctor) return null;

  const rec = new Ctor();
  rec.lang = opts.lang || 'zh-CN';
  rec.continuous = false;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  let active = true;

  rec.onresult = (event: any) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      const text = res[0]?.transcript ?? '';
      if (res.isFinal) {
        const trimmed = text.trim();
        if (trimmed) opts.onFinal?.(trimmed);
      } else {
        interim += text;
      }
    }
    if (interim.trim()) opts.onInterim?.(interim.trim());
  };

  rec.onerror = (event: any) => {
    const err = String(event?.error ?? 'unknown');
    // Silence benign lifecycle errors; surface real ones (e.g. not-allowed).
    if (err !== 'no-speech' && err !== 'aborted') opts.onError?.(err);
  };

  rec.onend = () => {
    active = false;
    opts.onEnd?.();
  };

  try {
    rec.start();
  } catch (err) {
    opts.onError?.(err instanceof Error ? err.message : String(err));
    return null;
  }

  return {
    stop() {
      active = false;
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    },
    isActive() {
      return active;
    },
  };
}

export interface ContinuousOptions {
  lang?: string;
  /** A finalized transcript segment. */
  onFinal?: (text: string) => void;
  /** Interim transcript for optional live feedback. */
  onInterim?: (text: string) => void;
  onError?: (error: string) => void;
}

/**
 * Hands-free continuous recognition for recording narration. Chrome stops the
 * recognizer after a silence window, so we auto-restart it while the session is
 * meant to be active, giving effectively-uninterrupted capture.
 */
export function createContinuous(opts: ContinuousOptions): SpeechSession | null {
  const Ctor = getCtor();
  if (!Ctor) return null;

  let active = true;
  let rec: SpeechRecognitionLike | null = null;

  const build = (): SpeechRecognitionLike => {
    const r = new Ctor();
    r.lang = opts.lang || 'zh-CN';
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;

    r.onresult = (event: any) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const text = res[0]?.transcript ?? '';
        if (res.isFinal) {
          const trimmed = text.trim();
          if (trimmed) opts.onFinal?.(trimmed);
        } else {
          interim += text;
        }
      }
      if (interim.trim()) opts.onInterim?.(interim.trim());
    };

    r.onerror = (event: any) => {
      const err = String(event?.error ?? 'unknown');
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        active = false; // permission denied — stop trying to restart.
        opts.onError?.(err);
      } else if (err !== 'no-speech' && err !== 'aborted') {
        opts.onError?.(err);
      }
    };

    r.onend = () => {
      // Restart while still active (Chrome ends after silence).
      if (active) {
        try {
          r.start();
        } catch {
          /* transient; will retry on next end */
        }
      }
    };

    return r;
  };

  try {
    rec = build();
    rec.start();
  } catch (err) {
    opts.onError?.(err instanceof Error ? err.message : String(err));
    return null;
  }

  return {
    stop() {
      active = false;
      try {
        rec?.stop();
      } catch {
        /* already stopped */
      }
    },
    isActive() {
      return active;
    },
  };
}
