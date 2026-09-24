import { createInterface } from "readline";
import type { Readable, Writable } from "stream";

type Message = { id?: number | string; method?: string; params?: any; result?: any; error?: { code?: number; message?: string } };

/** One stdio app-server connection for one GitBot turn. Server requests stay
 * open until the user answers them through GitBot's permission endpoint. */
export class CodexAppServer {
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private ended = false;
  private reader;

  constructor(
    private input: Writable,
    output: Readable,
    private onMessage: (message: Message) => void,
  ) {
    this.reader = createInterface({ input: output, crlfDelay: Infinity });
    this.reader.on("line", (line) => {
      let message: Message;
      try { message = JSON.parse(line); }
      catch { return; }
      if (message.id !== undefined && !message.method) {
        const pending = this.pending.get(Number(message.id));
        if (!pending) return;
        this.pending.delete(Number(message.id));
        if (message.error) pending.reject(new Error(message.error.message ?? "Codex request failed"));
        else pending.resolve(message.result);
      } else {
        this.onMessage(message);
      }
    });
    this.reader.on("close", () => this.fail(new Error("Codex app-server closed unexpectedly")));
  }

  request(method: string, params: Record<string, unknown>): Promise<any> {
    if (this.ended) return Promise.reject(new Error("Codex app-server is closed"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.send({ method, params });
  }

  respond(id: number | string, result: Record<string, unknown>): void {
    this.send({ id, result });
  }

  reject(id: number | string, message: string): void {
    this.send({ id, error: { code: -32601, message } });
  }

  fail(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  close(): void {
    this.fail(new Error("Codex app-server closed"));
    this.reader.close();
  }

  private send(message: Message): void {
    if (this.ended || !this.input.writable) throw new Error("Codex app-server is closed");
    this.input.write(`${JSON.stringify(message)}\n`);
  }
}
