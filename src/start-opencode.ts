import { basename } from "path";
import {
  emitEvent,
  scheduleCleanup,
  sessions,
  notifyNewPermission,
  notifyPermissionsChanged,
  notifySessionDone,
  shouldAutoApprove,
  type SessionStore,
} from "./server-common";

async function loadOpencodeSdk() {
  const sdk = await import("@opencode-ai/sdk");
  return { createOpencode: sdk.createOpencode, createOpencodeClient: sdk.createOpencodeClient };
}

// Per-directory opencode clients
const clientsByDir = new Map<string, any>();

// Reverse-lookup: opencode session ID → gitbot session ID
const sdkIdToGitbotId = new Map<string, string>();

// Cache of subagent (child) sdkSessionId → root gitbot session ID, populated by walking parentID.
const childSdkIdToRootGitbotId = new Map<string, string>();
// Dedupe concurrent in-flight parent walks for the same sdkSessionId.
const resolveInflight = new Map<string, Promise<SessionStore | undefined>>();

let sdkLoaded: any = null;

const permissionConfig = {
  edit: "ask",
  bash: "ask",
  webfetch: "ask",
  doom_loop: "ask",
  external_directory: "ask",
} as const;

export async function initAgent(): Promise<boolean> {
  const loaded = await loadOpencodeSdk().catch(() => null) as any;

  if (!loaded?.createOpencode || !loaded?.createOpencodeClient) {
    console.warn("  @opencode-ai/sdk not found — opencode agent unavailable");
    return false;
  }

  sdkLoaded = loaded;

  try {
    const result = await loaded.createOpencode({ config: { permission: permissionConfig } });
    // Seed the default client (no directory) from the spawned server's client
    clientsByDir.set("", result.client);
    console.log("  opencode: ready");
  } catch {
  }

  return true;
}

async function getClientForDir(directory: string): Promise<any> {
  if (clientsByDir.has(directory)) return clientsByDir.get(directory);

  const { createOpencodeClient } = sdkLoaded;
  const client = createOpencodeClient({ baseUrl: "http://127.0.0.1:4096", directory });
  clientsByDir.set(directory, client);

  try {
    const configResult = await client.config.get();
    const currentConfig = (configResult.data ?? {}) as Record<string, any>;
    await client.config.update({
      body: { ...currentConfig, permission: permissionConfig },
    });
  } catch (err: any) {
    console.warn("  permissions: could not set permission config:", err?.message);
  }

  startEventStream(client, directory).catch((err) => {
    console.error("[gitbot] startEventStream crashed:", err);
  });
  return client;
}

export async function runAgent(store: SessionStore): Promise<void> {
  const lastUserEvent = [...store.events].reverse().find(e => e.type === "user_prompt");
  const prompt = (lastUserEvent?.prompt as string) ?? "";
  const attachments = lastUserEvent?.attachments as Array<{ url: string }> | undefined;
  (store as any)._msgRoles = new Map<string, string>();
  store.lastTaskToolUseId = undefined;
  const client = await getClientForDir(store.repoPath);

  try {
    if (!store.sdkSessionId) {
      const repoName = basename(store.repoPath);
      const sessionResult = await client.session.create({
        body: { title: `[${repoName}] ${prompt.slice(0, 60) || (attachments?.length ? "Image message" : "New chat")}` },
        query: { directory: store.repoPath },
      });
      const sdkId = (sessionResult.data as any).id as string;
      store.sdkSessionId = sdkId;
      emitEvent(store, "system", { subtype: "init", session_id: sdkId });
    }
    // Always register the mapping so event stream can find the store
    sdkIdToGitbotId.set(store.sdkSessionId!, store.gitbotId);


    // Parse model string into providerID/modelID if provided
    let modelParam: { providerID: string; modelID: string } | undefined;
    if (store.model) {
      const slashIdx = store.model.indexOf("/");
      if (slashIdx !== -1) {
        modelParam = {
          providerID: store.model.slice(0, slashIdx),
          modelID: store.model.slice(slashIdx + 1),
        };
      }
    }

    // Use promptAsync so the request returns immediately; completion signaled via event stream
    const promptResult = await client.session.promptAsync({
      path: { id: store.sdkSessionId! },
      body: {
        parts: [
          ...(prompt ? [{ type: "text" as const, text: prompt }] : []),
          ...(attachments?.map(att => ({ type: "file" as const, mime: "image/jpeg", url: att.url })) ?? []),
        ],
        ...(modelParam ? { model: modelParam } : {}),
        ...(store.mode ? { agent: store.mode } : {}),
      },
    });
    if (promptResult.error) {
      const errMsg = (promptResult.error as any)?.detail || (promptResult.error as any)?.message || "Prompt failed";
      console.error("[query] promptAsync error:", errMsg);
      emitEvent(store, "agent_error", { message: errMsg });
      store.status = "error";
      notifyPermissionsChanged();
      scheduleCleanup(store);
      return;
    }
    // completion signaled via event stream (session.idle or session.status idle)
  } catch (err: any) {
    console.error("[query] error:", err.message);
    emitEvent(store, "agent_error", { message: err?.message ?? "Unknown error" });
    store.status = "error";
    notifyPermissionsChanged();
    scheduleCleanup(store);
  }
}

export async function getSessionHistory(sdkSessionId: string, directory: string = ""): Promise<{ role: string; content: any[] }[]> {
  const client = await getClientForDir(directory);
  try {
    const messagesResult = await client.session.messages({ path: { id: sdkSessionId } });
    const allMsgs = messagesResult.data ?? [];
    const history: { role: string; content: any[] }[] = [];
    for (const msg of allMsgs) {
      const role = (msg as any).info?.role;
      const parts = (msg as any).parts ?? [];
      if (role === "user" || role === "assistant") {
        const blocks: any[] = [];
        for (const p of parts) {
          if (p.type === "text" && p.text) blocks.push({ type: "text", text: p.text });
          else if (p.type === "file" && p.url) blocks.push({ type: "image_url", url: p.url });
          else if (p.type === "tool") {
            const toolName = p.tool ?? "";
            const input = p.state?.input;
            let tool_input: string;
            try {
              tool_input = JSON.stringify(input) ?? "";
            } catch {
              tool_input = "";
            }
            blocks.push({ type: "tool_use", tool_name: toolName, tool_input });
          }
        }
        if (blocks.length) history.push({ role, content: blocks });
      }
    }
    return history;
  } catch (err: any) {
    console.error("Error loading opencode history:", err.message);
    return [];
  }
}

export async function listSessions(
  repoPath: string
): Promise<{ id: string; preview: string; updatedAt: string }[]> {
  const client = await getClientForDir(repoPath);
  try {
    const listOptions = repoPath ? { query: { directory: repoPath } } : undefined;
    const result = await client.session.list(listOptions);
    // Subagent sessions (parentID set) belong nested under their parent thread, not at chat-history top level.
    const sessionList = (result.data ?? [])
      .filter((s: any) => !s.parentID)
      .map((s: any) => ({
        id: s.id,
        preview: s.title || s.id,
        updatedAt: (() => {
          const ts = s.time?.updated || s.time?.created || 0;
          const ms = ts > 1e12 ? ts : ts * 1000;
          return new Date(ms).toISOString();
        })(),
      }));
    sessionList.sort((a: any, b: any) => b.updatedAt.localeCompare(a.updatedAt));
    return sessionList;
  } catch (err: any) {
    console.error("Error listing sessions:", err.message);
    return [];
  }
}

export async function abortSession(sdkSessionId: string, directory: string = ""): Promise<void> {
  const client = await getClientForDir(directory);
  await client.session.abort({ path: { id: sdkSessionId } });
}

export async function respondPermission(
  sdkSessionId: string,
  permissionId: string,
  approved: boolean,
  directory: string = ""
): Promise<void> {
  const client = await getClientForDir(directory);
  await client.postSessionIdPermissionsPermissionId({
    path: { id: sdkSessionId, permissionID: permissionId },
    body: { response: approved ? "once" : "reject" },
  });
}

// Extract sessionID from any event's properties
function extractSessionId(_type: string, props: any): string | undefined {
  if (props?.sessionID) return props.sessionID;
  if (props?.info?.sessionID) return props.info.sessionID;
  if (props?.part?.sessionID) return props.part.sessionID;
  return undefined;
}

function findStoreByOpencodeSdkId(sdkId: string): SessionStore | undefined {
  const gitbotId = sdkIdToGitbotId.get(sdkId) ?? childSdkIdToRootGitbotId.get(sdkId);
  if (!gitbotId) return undefined;
  return sessions.get(gitbotId);
}

// Walk session.parentID via the SDK until we land on a session we own (root) or run out.
// Returns the root gitbot store and caches the mapping. Used to route subagent events
// to the parent thread.
async function resolveParentStore(client: any, sdkSessionId: string): Promise<SessionStore | undefined> {
  const direct = findStoreByOpencodeSdkId(sdkSessionId);
  if (direct) return direct;

  const inflight = resolveInflight.get(sdkSessionId);
  if (inflight) return inflight;

  const promise = (async () => {
    let cur = sdkSessionId;
    for (let hops = 0; hops < 5; hops++) {
      const got = await client.session.get({ path: { id: cur } }).catch(() => null);
      const data = got?.data;
      if (!data?.parentID) return undefined;
      cur = data.parentID;
      const rootGitbotId = sdkIdToGitbotId.get(cur);
      if (rootGitbotId) {
        childSdkIdToRootGitbotId.set(sdkSessionId, rootGitbotId);
        return sessions.get(rootGitbotId);
      }
    }
    return undefined;
  })();
  resolveInflight.set(sdkSessionId, promise);
  promise.finally(() => resolveInflight.delete(sdkSessionId));
  return promise;
}

async function startEventStream(client: any, directory: string) {
  try {
    const events = await client.event.subscribe();
    for await (const event of events.stream) {
      const type = event.type as string;
      const props = event.properties as any;

      const sdkSessionId = extractSessionId(type, props);
      if (!sdkSessionId) continue;

      let store = findStoreByOpencodeSdkId(sdkSessionId);
      if (!store) {
        // First event from a not-yet-mapped session: kick off the parent walk
        // in the background and drop this event. Awaiting here would stall the
        // for-await loop and back up every other session's events behind one
        // SDK round-trip. By the next event from this child, the cache is warm.
        void resolveParentStore(client, sdkSessionId);
        continue;
      }
      // Child events: store was reached via childSdkIdToRootGitbotId (root's parent store),
      // so its sdkSessionId differs from the event's sdkSessionId.
      const isChildEvent = sdkSessionId !== store.sdkSessionId;

      // Track message roles so we can filter out user message parts
      if (type === "message.updated") {
        const info = props.info;
        if (info?.id && info?.role) {
          if (!(store as any)._msgRoles) (store as any)._msgRoles = new Map<string, string>();
          (store as any)._msgRoles.set(info.id, info.role);
        }
      }

      if (type === "message.part.updated") {
        const part = props.part;
        const msgRole = (store as any)._msgRoles?.get(part.messageID);
        const parentToolUseId = isChildEvent ? store.lastTaskToolUseId : undefined;

        if (part.type === "text") {
          const text = part.text ?? "";
          if (text && msgRole === "assistant") {
            emitEvent(store, "assistant", {
              content: text,
              ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
            });
          }
        }
        if (part.type === "tool") {
          const state = part.state;
          if (state?.status === "running" || state?.status === "completed") {
            const title = state.title;
            const input = state.input ?? {};
            const label = title || formatToolInput(part.tool, input);
            // Remember the parent's most-recent Task callID so child-session events
            // can attach to it via parent_tool_use_id.
            if (!isChildEvent && part.tool === "task" && part.callID) {
              store.lastTaskToolUseId = part.callID;
            }
            emitEvent(store, "tool_use", {
              tool_name: part.tool,
              tool_input: label,
              ...(part.callID ? { tool_use_id: part.callID } : {}),
              ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
            });
          }
        }
        if (part.type === "step-start" && !isChildEvent) {
          emitEvent(store, "status", { status: "thinking" });
        }
      }

      if (type === "permission.asked") {
        const permId = props.id;
        const permType = props.permission as string || "";
        const patterns: string[] = props.patterns ?? [];

        let toolName: string;
        let input: Record<string, unknown>;
        if (permType === "bash") {
          toolName = "Bash";
          input = { command: patterns.join(" ") };
        } else if (permType === "edit") {
          toolName = "Edit";
          const filePath = props.metadata?.filepath || patterns[0] || "";
          const diff = props.metadata?.diff as string | undefined;
          let old_string = "";
          let new_string = "";
          if (diff) {
            const removed: string[] = [];
            const added: string[] = [];
            for (const line of (diff as string).split("\n")) {
              if (line.startsWith("-") && !line.startsWith("---")) removed.push(line.slice(1));
              else if (line.startsWith("+") && !line.startsWith("+++")) added.push(line.slice(1));
            }
            old_string = removed.join("\n");
            new_string = added.join("\n");
          }
          input = { file_path: filePath, old_string, new_string };
        } else if (permType === "webfetch") {
          toolName = "WebFetch";
          input = { url: patterns[0] ?? "" };
        } else {
          toolName = permType || props.title || "Unknown";
          input = patterns.length > 0 ? { patterns } : (props.metadata ?? {});
        }

        if (permId) {
          if (shouldAutoApprove(store.agent, toolName, store.permissionMode)) {
            // Respond on the child's own sdkSessionId, not the parent's.
            respondPermission(sdkSessionId, permId, true, store.repoPath).catch(() => {});
          } else {
            const parentToolUseId = isChildEvent ? store.lastTaskToolUseId : undefined;
            store.pendingPermissions.set(permId, {
              resolve: () => {},
              input,
              toolName,
              toolUseID: permId,
              askedBySdkSessionId: sdkSessionId,
            });
            notifyNewPermission(toolName);
            emitEvent(store, "permission_request", {
              toolUseID: permId,
              toolName,
              input,
              ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
            });
          }
        }
      }

      // Child-session lifecycle events do NOT terminate the parent thread —
      // the parent's own session.idle/error governs the thread's lifecycle.
      if (isChildEvent) continue;

      if (type === "session.error") {
        const err = props?.error;
        const message = err?.data?.message || err?.message || err?.name || "Session error";
        emitEvent(store, "agent_error", { message });
        store.status = "error";
        store.pendingPermissions.clear();
        notifyPermissionsChanged();
        scheduleCleanup(store);
      }

      if (type === "session.idle" || (type === "session.status" && props?.status?.type === "idle")) {
        if (store.status === "done") continue;
        store.status = "done";
        store.pendingPermissions.clear();
        notifyPermissionsChanged();
        emitEvent(store, "done", {});
        notifySessionDone(store);
        scheduleCleanup(store);
      }
    }
  } catch (err: any) {
    console.error("[event-stream] error:", err.message);
    setTimeout(() => startEventStream(client, directory), 2000);
  }
}

function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  const name = toolName.toLowerCase().replace(/_/g, "");
  switch (name) {
    case "bash":
      return input.command
        ? (input.description ? `${input.description}: ${input.command}` : `${input.command}`)
        : toolName;
    case "read":
    case "readfile":
      return input.file_path ? `${input.file_path}` : toolName;
    case "write":
    case "writefile": {
      if (!input.file_path) return toolName;
      const len = typeof input.content === "string" ? input.content.length : null;
      return len != null ? `${input.file_path} (${len} chars)` : `${input.file_path}`;
    }
    case "edit":
    case "editfile":
      return input.file_path ? `${input.file_path}` : toolName;
    case "glob":
      return input.pattern
        ? (input.path ? `${input.pattern} in ${input.path}` : `${input.pattern}`)
        : toolName;
    case "grep":
      return input.pattern
        ? (input.path ? `/${input.pattern}/ in ${input.path}` : `/${input.pattern}/`)
        : toolName;
    case "task":
      return input.description ? `[${input.subagent_type}] ${input.description}` : toolName;
    case "webfetch":
      return input.url ? `${input.url}` : toolName;
    case "websearch":
      return input.query ? `"${input.query}"` : toolName;
    case "notebookedit":
      return input.notebook_path ? `${input.notebook_path} (${input.edit_mode || "replace"})` : toolName;
    default: {
      const vals = Object.values(input).filter(v => typeof v === "string" && v.length < 100);
      return vals.length > 0 ? `${vals[0]}` : toolName;
    }
  }
}
