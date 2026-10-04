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
// IndexedDB — crash-safe storage for the raw transcript + WAV blob.
// Both are stored under the same record key "current" so they're atomic.
// ---------------------------------------------------------------------------

const DB_NAME = "dictation";
const DB_VERSION = 1;
const STORE = "drafts";

interface DraftRecord {
  id: "current";
  transcript: string;
  audio: Blob | null;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSave(transcript: string, audio: Blob | null): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const record: DraftRecord = { id: "current", transcript, audio };
      const req = tx.objectStore(STORE).put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Storage failure is non-fatal — the session continues without persistence
  }
}

async function idbLoad(): Promise<DraftRecord | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get("current");
      req.onsuccess = () => resolve((req.result as DraftRecord) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function idbClear(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const req = tx.objectStore(STORE).delete("current");
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {}
}

// ---------------------------------------------------------------------------
// Cleanup helpers (ported from murmur's Formatter.swift)
// ---------------------------------------------------------------------------

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
// WAV encoding — wraps raw Int16 PCM chunks into a retryable Blob
// ---------------------------------------------------------------------------

function encodeWav(chunks: Int16Array[], sampleRate = 16000): Blob {
  const totalSamples = chunks.reduce((n, c) => n + c.length, 0);
  const dataBytes = totalSamples * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);        // PCM
  view.setUint16(22, 1, true);        // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataBytes, true);

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
  /** Non-empty when a previous session crashed before cleanup finished.
   *  The raw transcript and audio blob are available for recovery.
   *  Call clearSavedDraft once the caller has consumed it. */
  savedDraft: string;
  savedAudio: Blob | null;
  clearSavedDraft: () => void;
} {
  const [state, setState] = useState<DictationState>("idle");
  const stateRef = useRef<DictationState>("idle");
  const onInterimRef = useRef(onInterim);
  const onFinalRef = useRef(onFinal);
  onInterimRef.current = onInterim;
  onFinalRef.current = onFinal;

  // Crash-recovery state — loaded from IndexedDB on mount
  const [savedDraft, setSavedDraft] = useState("");
  const [savedAudio, setSavedAudio] = useState<Blob | null>(null);

  const clearSavedDraft = useCallback(() => {
    void idbClear();
    setSavedDraft("");
    setSavedAudio(null);
  }, []);

  // Load any crash-surviving draft on mount
  useEffect(() => {
    idbLoad().then((record) => {
      if (record?.transcript) {
        setSavedDraft(record.transcript);
        setSavedAudio(record.audio ?? null);
      }
    });
  }, []);

  // Refs for the live recording session
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletBlobUrlRef = useRef<string | null>(null);
  const finalsRef = useRef<string[]>([]);
  const dgKeyRef = useRef<string | null>(null);
  const pcmChunksRef = useRef<Int16Array[]>([]);

  const setStateBoth = (s: DictationState) => {
    stateRef.current = s;
    setState(s);
  };

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

        if (r.from_finalize) ws.close(1000);
      } else if (msg.type === "Metadata") {
        ws.close(1000);
      } else if (msg.type === "Error") {
        console.warn("[Deepgram] error:", (msg as DeepgramErrorMessage).message);
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

      if (!raw) {
        pcmChunksRef.current = [];
        setStateBoth("idle");
        return;
      }

      if (!needsCleanup(raw)) {
        pcmChunksRef.current = [];
        onFinalRef.current(raw);
        setStateBoth("idle");
        return;
      }

      // Encode PCM into a WAV blob and persist both to IndexedDB before the
      // LLM call. If the page crashes mid-cleanup, next mount restores both.
      const wavBlob = pcmChunksRef.current.length > 0
        ? encodeWav(pcmChunksRef.current)
        : null;
      pcmChunksRef.current = [];

      await idbSave(raw, wavBlob);

      setStateBoth("cleaning");
      const cleaned = await cleanTranscript(raw);
      onFinalRef.current(cleaned);

      // Cleanup succeeded — remove the safety net
      await idbClear();

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
      pcmChunksRef.current.push(new Int16Array(buf));
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
      scriptNode.connect(ctx.destination);
    }
  }, [getDgKey, stopSession]);

  const toggle = useCallback(() => {
    if (stateRef.current === "idle") {
      startRecording();
    } else if (stateRef.current === "recording") {
      stopSession(true);
    }
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

  return { state, supported: true, toggle, savedDraft, savedAudio, clearSavedDraft };
}
