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
// localStorage key for crash-safe transcript recovery
// ---------------------------------------------------------------------------

const LS_KEY = "dictation:draft";

function saveDraft(text: string) {
  try { localStorage.setItem(LS_KEY, text); } catch {}
}

function clearDraft() {
  try { localStorage.removeItem(LS_KEY); } catch {}
}

function loadDraft(): string {
  try { return localStorage.getItem(LS_KEY) ?? ""; } catch { return ""; }
}

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
  if (words < 4) return false;
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
// WAV encoding — wraps raw Int16 PCM chunks into a playable/retryable blob
// ---------------------------------------------------------------------------

function encodeWav(chunks: Int16Array[], sampleRate = 16000): Blob {
  const totalSamples = chunks.reduce((n, c) => n + c.length, 0);
  const dataBytes = totalSamples * 2; // Int16 = 2 bytes/sample
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const write = (off: number, val: number, bytes: number, le = true) => {
    if (bytes === 4) le ? view.setUint32(off, val, true) : view.setUint32(off, val);
    else if (bytes === 2) le ? view.setUint16(off, val, true) : view.setUint16(off, val);
    else view.setUint8(off, val);
  };
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  writeStr(0, "RIFF");
  write(4, 36 + dataBytes, 4);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  write(16, 16, 4);       // PCM chunk size
  write(20, 1, 2);        // PCM format
  write(22, 1, 2);        // mono
  write(24, sampleRate, 4);
  write(28, sampleRate * 2, 4); // byte rate
  write(32, 2, 2);        // block align
  write(34, 16, 2);       // bits per sample
  writeStr(36, "data");
  write(40, dataBytes, 4);

  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      view.setInt16(offset, chunk[i], true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: "audio/wav" });
}

// ---------------------------------------------------------------------------
// AudioWorklet processor (inlined as a Blob URL — no extra build step needed)
// Converts Float32 mic samples → Int16 PCM and posts them to the main thread.
// ---------------------------------------------------------------------------

const WORKLET_CODE = `
class PcmProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
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
  /** Raw transcript saved to localStorage during cleanup; non-empty if a
   *  previous session crashed before cleanup finished. Call clearSavedDraft
   *  once the caller has consumed it. */
  savedDraft: string;
  clearSavedDraft: () => void;
} {
  const [state, setState] = useState<DictationState>("idle");
  const stateRef = useRef<DictationState>("idle");
  const onInterimRef = useRef(onInterim);
  const onFinalRef = useRef(onFinal);
  onInterimRef.current = onInterim;
  onFinalRef.current = onFinal;

  // Crash-recovery: raw transcript saved to localStorage while cleanup runs
  const [savedDraft, setSavedDraft] = useState<string>(() => loadDraft());
  const clearSavedDraft = useCallback(() => {
    clearDraft();
    setSavedDraft("");
  }, []);

  // Refs for the live recording session
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletBlobUrlRef = useRef<string | null>(null);
  const finalsRef = useRef<string[]>([]);
  const dgKeyRef = useRef<string | null>(null);

  // Accumulated raw PCM chunks — kept in memory for same-session retry
  const pcmChunksRef = useRef<Int16Array[]>([]);
  // Object URL of the WAV blob (revoked after cleanup succeeds)
  const audioBlobUrlRef = useRef<string | null>(null);

  const setStateBoth = (s: DictationState) => {
    stateRef.current = s;
    setState(s);
  };

  const revokeAudioBlob = () => {
    if (audioBlobUrlRef.current) {
      URL.revokeObjectURL(audioBlobUrlRef.current);
      audioBlobUrlRef.current = null;
    }
    pcmChunksRef.current = [];
  };

  // Fetch the Deepgram key from the server (cached only on success).
  const getDgKey = useCallback(async (): Promise<string | null> => {
    if (dgKeyRef.current !== null) return dgKeyRef.current || null;
    try {
      const res = await fetch("/api/dictation-key");
      if (!res.ok) return null;
      const data = (await res.json()) as { key?: string };
      const key = data.key ?? "";
      dgKeyRef.current = key;
      return key || null;
    } catch {
      return null;
    }
  }, []);

  const stopSession = useCallback(async (sendFinalize: boolean) => {
    const ws = wsRef.current;
    const stream = streamRef.current;
    const ctx = audioCtxRef.current;

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
    pcmChunksRef.current = [];
    revokeAudioBlob();

    const key = await getDgKey();
    if (!key) {
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
          onInterimRef.current(finalsRef.current.join(" "));
        } else {
          const interim = finalsRef.current.join(" ");
          onInterimRef.current(interim ? `${interim} ${text}` : text);
        }

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
      const ctx = audioCtxRef.current;
      if (ctx) { await ctx.close().catch(() => {}); audioCtxRef.current = null; }
      const stream = streamRef.current;
      if (stream) { stream.getTracks().forEach((t) => t.stop()); streamRef.current = null; }

      const raw = finalsRef.current.join(" ").trim();
      finalsRef.current = [];

      // Encode accumulated PCM into a WAV blob for same-session retry
      if (pcmChunksRef.current.length > 0) {
        const wavBlob = encodeWav(pcmChunksRef.current);
        revokeAudioBlob(); // revoke any previous
        audioBlobUrlRef.current = URL.createObjectURL(wavBlob);
        // pcmChunksRef stays populated so the blob stays valid
      }

      if (!raw) {
        setStateBoth("idle");
        return;
      }

      if (!needsCleanup(raw)) {
        // Short clean transcript — no LLM needed, no need to save
        onFinalRef.current(raw);
        revokeAudioBlob();
        setStateBoth("idle");
        return;
      }

      // Save raw transcript to localStorage before hitting the LLM.
      // If the page crashes or reloads during cleanup, the user's words survive.
      saveDraft(raw);
      setSavedDraft(raw);

      setStateBoth("cleaning");
      const cleaned = await cleanTranscript(raw);
      onFinalRef.current(cleaned);

      // Cleanup succeeded — remove the safety net
      clearDraft();
      setSavedDraft("");
      revokeAudioBlob();

      setStateBoth("idle");
    });

    ws.addEventListener("error", () => {
      // close event fires after error and handles cleanup
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

    // --- 3. Audio pipeline: Float32 → Int16 PCM → WebSocket + local buffer ---
    const ctx = new AudioContext({ sampleRate: 16000 });
    audioCtxRef.current = ctx;
    const source = ctx.createMediaStreamSource(stream);

    const sendPcm = (float32: Float32Array) => {
      const buf = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        buf[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      // Store a copy locally for WAV encoding
      pcmChunksRef.current.push(new Int16Array(buf));
      // Send to Deepgram
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(buf.buffer);
      }
    };

    // Try AudioWorklet (preferred)
    let workletOk = false;
    if (typeof ctx.audioWorklet?.addModule === "function") {
      try {
        if (!workletBlobUrlRef.current) {
          const blob = new Blob([WORKLET_CODE], { type: "application/javascript" });
          workletBlobUrlRef.current = URL.createObjectURL(blob);
        }
        await ctx.audioWorklet.addModule(workletBlobUrlRef.current);
        const workletNode = new AudioWorkletNode(ctx, "pcm-processor");
        workletNode.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
          sendPcm(new Float32Array(e.data));
        };
        source.connect(workletNode);
        workletOk = true;
      } catch {
        // fall through to ScriptProcessor
      }
    }

    // ScriptProcessor fallback (deprecated but universally supported on mobile)
    if (!workletOk) {
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      const scriptNode = ctx.createScriptProcessor(4096, 1, 1);
      scriptNode.onaudioprocess = (e) => {
        sendPcm(e.inputBuffer.getChannelData(0));
      };
      source.connect(scriptNode);
      scriptNode.connect(ctx.destination); // must be connected to run
    }
  }, [getDgKey, stopSession]);

  const toggle = useCallback(() => {
    if (stateRef.current === "idle") {
      startRecording();
    } else if (stateRef.current === "recording") {
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
      revokeAudioBlob();
    };
  }, []);

  return { state, supported: true, toggle, savedDraft, clearSavedDraft };
}
