"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type DictationState = "idle" | "recording" | "cleaning";

interface UseDictationOptions {
  /** Called with interim text as words arrive. */
  onInterim: (text: string) => void;
  /** Called with the final cleaned transcript once cleanup is done. */
  onFinal: (text: string) => void;
}

// Minimal type shim so TypeScript compiles without a lib that includes the
// Web Speech API (it is available at runtime in Chrome/Edge/Safari).
declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionInstance;
    webkitSpeechRecognition?: new () => SpeechRecognitionInstance;
  }
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
}

interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionResultList {
  length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
}

/** Returns true if this transcript is already clean enough to skip the LLM. */
function needsCleanup(text: string): boolean {
  const trimmed = text.trim();
  // Very short: not worth an API call
  if (trimmed.length < 8) return false;
  // Only single word
  if (!trimmed.includes(" ")) return false;
  return true;
}

async function cleanTranscript(raw: string): Promise<string> {
  try {
    const res = await fetch("/api/dictation-cleanup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: raw }),
    });
    if (!res.ok) return raw;
    const data = (await res.json()) as { cleaned?: string };
    return data.cleaned ?? raw;
  } catch {
    return raw;
  }
}

export function useDictation({ onInterim, onFinal }: UseDictationOptions): {
  state: DictationState;
  supported: boolean;
  toggle: () => void;
} {
  const [state, setState] = useState<DictationState>("idle");
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const finalTranscriptRef = useRef<string>("");
  const onInterimRef = useRef(onInterim);
  const onFinalRef = useRef(onFinal);
  onInterimRef.current = onInterim;
  onFinalRef.current = onFinal;

  // Detect support once on mount
  const supported =
    typeof window !== "undefined" &&
    !!(window.SpeechRecognition ?? window.webkitSpeechRecognition);

  const stopRecording = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
    }
  }, []);

  const startRecording = useCallback(() => {
    const SpeechRecognitionCtor =
      window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) return;

    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    finalTranscriptRef.current = "";

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interimTranscript = "";
      let finalTranscript = finalTranscriptRef.current;

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript;
        if (result.isFinal) {
          finalTranscript += (finalTranscript ? " " : "") + text;
        } else {
          interimTranscript += text;
        }
      }

      finalTranscriptRef.current = finalTranscript;
      onInterimRef.current(
        finalTranscript + (interimTranscript ? " " + interimTranscript : ""),
      );
    };

    recognition.onerror = (_event: SpeechRecognitionErrorEvent) => {
      // On error just fall through to onend which handles cleanup
    };

    recognition.onend = async () => {
      recognitionRef.current = null;
      const raw = finalTranscriptRef.current.trim();

      if (!raw) {
        setState("idle");
        return;
      }

      if (!needsCleanup(raw)) {
        onFinalRef.current(raw);
        setState("idle");
        return;
      }

      setState("cleaning");
      const cleaned = await cleanTranscript(raw);
      onFinalRef.current(cleaned);
      setState("idle");
    };

    recognitionRef.current = recognition;
    recognition.start();
    setState("recording");
  }, []);

  const toggle = useCallback(() => {
    if (state === "idle") {
      startRecording();
    } else if (state === "recording") {
      stopRecording();
    }
    // While cleaning, the button is a spinner — ignore clicks
  }, [state, startRecording, stopRecording]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.abort();
        recognitionRef.current = null;
      }
    };
  }, []);

  return { state, supported, toggle };
}
