"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type DictationState = "idle" | "recording" | "cleaning";

interface UseDictationOptions {
  /** Called with interim text as words arrive from Deepgram. */
  onInterim: (text: string) => void;
  /** Called with the final cleaned transcript once cleanup is done. */
  onFinal: (text: string) => void;
}

// ---------------------------------------------------------------------------
// Deepgram response shapes (subset we care about)
// ---------------------------------------------------------------------------

interface DeepgramWord {
  punctuated_word?: string;
  word: string;
  confidence: number;
}

interface DeepgramAlternative {
  transcript: string;
  words?: DeepgramWord[];
}

interface DeepgramChannel {
  alternatives?: DeepgramAlternative[];
}

interface DeepgramResultsMessage {
  type: "Results";
  is_final: boolean;
  from_finalize?: boolean;
  channel?: DeepgramChannel;
}

interface DeepgramMetadataMessage {
  type: "Metadata";
}

interface DeepgramErrorMessage {
  type: "Error";
  message?: string;
}

type DeepgramMessage =
  | DeepgramResultsMessage
  | DeepgramMetadataMessage
  | DeepgramErrorMessage
  | { type: string };

// ---------------------------------------------------------------------------
// Cleanup helpers (ported from murmur's Formatter.swift)
// ---------------------------------------------------------------------------

/**
 * Deepgram's smart_format already punctuates and handles most um/uh, so skip
 * the LLM pass for short clean transcripts. Mirrors Formatter.needsCleanup.
 */
function needsCleanup(text: string): boolean {
  const t = text.trim().toLowerCase();
  const words = t.split(/\s+/).filter(Boolean).length;
  // Very short single thought → no LLM needed
  if (words < 4) return false;
  // Long utterance: always worth a cleanup pass
  if (words >= 15) return true;

  const cues = [
    /\b(um+|uh+|erm+|hmm+|you know)\b/,
    /\b(\w+),?\s+\1\b/,
    /\b(no wait|wait no|scratch that|never mind|i mean|i meant|or rather|sorry,?\s+(i|what|that|let))\b/,
    /\b(new line|next line|new paragraph|bullet point|full stop|question mark)\b/,
    /\bnumber (one|1)\b.*\bnumber (two|2)\b/,
    /\bfirst\b.*\bsecond\b/,
    /[.?!]\s+(of|than|which|though|or|so that)\b/,
    /\b(the|a|an|of|from|for|with|and|or|but)\.\s*$/,
    /\byour (right|wrong|welcome|sure|correct)(\s*[.,?!]|$|\s+(about|that|here))/,
    /\bits (a|an|the|not|been|going|just|so|too|fine|okay)\b/,
    /\b(more|less|better|worse|rather|faster|slower|easier|harder) then\b/,
  ];
  return cues.some((re) => re.test(t));
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
    return data.cleaned?.trim() || raw;
  } catch {
    return raw;
  }
}

// ---------------------------------------------------------------------------
// AudioWorklet processor (inlined as a Blob URL so no extra build step needed)
// Converts Float32 mic samples → Int16 PCM and sends them to the main thread.
// ---------------------------------------------------------------------------

const WORKLET_CODE = `
class PcmProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    // Float32 → Int16 (clamp)
    const buf = new Int16Array(ch.length);
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      buf[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.port.postMessage(buf.buffer, [buf.buffer]);
    return true;
  }
}
registerProcessor('pcm-processor', PcmProcessor);
`;

// ---------------------------------------------------------------------------
// Main hook
// ---------------------------------------------------------------------------

export function useDictation({ onInterim, onFinal }: UseDictationOptions): {
  state: DictationState;
  supported: boolean;
  toggle: () => void;
} {
  const [state, setState] = useState<DictationState>("idle");
  const stateRef = useRef<DictationState>("idle");
  const onInterimRef = useRef(onInterim);
  const onFinalRef = useRef(onFinal);
  onInterimRef.current = onInterim;
  onFinalRef.current = onFinal;

  // Refs for the live recording session
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletBlobUrlRef = useRef<string | null>(null);
  const finalsRef = useRef<string[]>([]);
  const dgKeyRef = useRef<string | null>(null); // cached after first fetch

  // Browser support: needs getUserMedia + AudioWorklet + WebSocket
  const supported =
    typeof window !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof AudioContext !== "undefined" &&
    typeof WebSocket !== "undefined";

  const setStateBoth = (s: DictationState) => {
    stateRef.current = s;
    setState(s);
  };

  // Fetch the Deepgram key from the server (cached after first call)
  const getDgKey = useCallback(async (): Promise<string | null> => {
    if (dgKeyRef.current !== null) return dgKeyRef.current || null;
    try {
      const res = await fetch("/api/dictation-key");
      if (!res.ok) { dgKeyRef.current = ""; return null; }
      const data = (await res.json()) as { key?: string };
      dgKeyRef.current = data.key ?? "";
      return dgKeyRef.current || null;
    } catch {
      dgKeyRef.current = "";
      return null;
    }
  }, []);

  const stopSession = useCallback(async (sendFinalize: boolean) => {
    const ws = wsRef.current;
    const stream = streamRef.current;
    const ctx = audioCtxRef.current;

    // Disconnect audio pipeline
    if (ctx) {
      await ctx.close().catch(() => {});
      audioCtxRef.current = null;
    }
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
      if (sendFinalize) {
        ws.send(JSON.stringify({ type: "Finalize" }));
        ws.send(JSON.stringify({ type: "CloseStream" }));
      } else {
        ws.close(1000);
        wsRef.current = null;
      }
    }
  }, []);

  const startRecording = useCallback(async () => {
    setStateBoth("recording");
    finalsRef.current = [];

    const key = await getDgKey();
    if (!key) {
      // No Deepgram key: fall back silently — hide the button
      setStateBoth("idle");
      return;
    }

    // --- 1. Open Deepgram WebSocket ---
    const params = new URLSearchParams({
      model: "nova-3",
      language: "en-US",
      encoding: "linear16",
      sample_rate: "16000",
      channels: "1",
      punctuate: "true",
      smart_format: "true",
      endpointing: "800",
    });
    const ws = new WebSocket(
      `wss://api.deepgram.com/v1/listen?${params}`,
      ["token", key],
    );
    wsRef.current = ws;

    ws.addEventListener("message", (evt: MessageEvent) => {
      if (typeof evt.data !== "string") return;
      let msg: DeepgramMessage;
      try { msg = JSON.parse(evt.data) as DeepgramMessage; } catch { return; }

      if (msg.type === "Results") {
        const r = msg as DeepgramResultsMessage;
        const alt = r.channel?.alternatives?.[0];
        const text = alt?.transcript?.trim() ?? "";
        if (!text) return;

        if (r.is_final) {
          finalsRef.current.push(text);
          // Show accumulated finals as the live preview
          onInterimRef.current(finalsRef.current.join(" "));
        } else {
          // Show finals + current interim
          const interim = finalsRef.current.join(" ");
          onInterimRef.current(interim ? `${interim} ${text}` : text);
        }

        // from_finalize means Deepgram has flushed everything after our Finalize
        if (r.from_finalize) {
          ws.close(1000);
        }
      } else if (msg.type === "Metadata") {
        ws.close(1000);
      } else if (msg.type === "Error") {
        const e = msg as DeepgramErrorMessage;
        console.warn("[Deepgram] error:", e.message);
        ws.close(1000);
      }
    });

    ws.addEventListener("close", async () => {
      wsRef.current = null;
      // Ensure audio pipeline is torn down
      const ctx = audioCtxRef.current;
      if (ctx) { await ctx.close().catch(() => {}); audioCtxRef.current = null; }
      const stream = streamRef.current;
      if (stream) { stream.getTracks().forEach((t) => t.stop()); streamRef.current = null; }

      const raw = finalsRef.current.join(" ").trim();
      finalsRef.current = [];

      if (!raw) {
        setStateBoth("idle");
        return;
      }

      if (!needsCleanup(raw)) {
        onFinalRef.current(raw);
        setStateBoth("idle");
        return;
      }

      setStateBoth("cleaning");
      const cleaned = await cleanTranscript(raw);
      onFinalRef.current(cleaned);
      setStateBoth("idle");
    });

    ws.addEventListener("error", () => {
      // close event will fire after error, which handles cleanup
    });

    // --- 2. Capture microphone at 16 kHz mono ---
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
    } catch {
      ws.close(1000);
      setStateBoth("idle");
      return;
    }
    streamRef.current = stream;

    // --- 3. AudioWorklet: Float32 → Int16 PCM → WebSocket ---
    const ctx = new AudioContext({ sampleRate: 16000 });
    audioCtxRef.current = ctx;

    // Create worklet blob URL once
    if (!workletBlobUrlRef.current) {
      const blob = new Blob([WORKLET_CODE], { type: "application/javascript" });
      workletBlobUrlRef.current = URL.createObjectURL(blob);
    }

    try {
      await ctx.audioWorklet.addModule(workletBlobUrlRef.current);
    } catch {
      // Fallback: ScriptProcessor (deprecated but widely supported)
      await ctx.close().catch(() => {});
      audioCtxRef.current = null;
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      ws.close(1000);
      setStateBoth("idle");
      return;
    }

    const source = ctx.createMediaStreamSource(stream);
    const workletNode = new AudioWorkletNode(ctx, "pcm-processor");

    workletNode.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(e.data);
      }
    };

    source.connect(workletNode);
    // Don't connect workletNode to destination (avoids mic feedback)
  }, [getDgKey, stopSession]);

  const toggle = useCallback(() => {
    if (stateRef.current === "idle") {
      startRecording();
    } else if (stateRef.current === "recording") {
      // User clicked stop: tear down audio, send Finalize, wait for WS close
      stopSession(true);
    }
    // While cleaning, ignore clicks
  }, [startRecording, stopSession]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      wsRef.current?.close(1000);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      audioCtxRef.current?.close().catch(() => {});
      if (workletBlobUrlRef.current) {
        URL.revokeObjectURL(workletBlobUrlRef.current);
      }
    };
  }, []);

  // Resolve `supported` to false if no Deepgram key is configured.
  // We track this via dgKeyRef: once we know it's empty, hide the button.
  // Initial render is optimistic (shows the button) until the first key fetch.
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  useEffect(() => {
    if (!supported) { setHasKey(false); return; }
    getDgKey().then((k) => setHasKey(k !== null));
  }, [supported, getDgKey]);

  const effectivelySupported = supported && hasKey !== false;

  return { state, supported: effectivelySupported, toggle };
}
