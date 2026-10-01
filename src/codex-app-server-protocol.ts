/**
 * codex app-server protocol types — GENERATED, do not edit by hand.
 *
 * Produced by:
 *
 *   codex app-server generate-ts --out <dir> --experimental
 *
 * from codex-cli **0.155.1**, the binary bundled with the `@openai/codex-sdk`
 * version this repo pins in package.json. Regenerate with the same command
 * after bumping that dependency; the diff is then the protocol change.
 *
 * This is a TRIMMED subset: the generator emits ~700 files (3.5 MB), most of it
 * app/plugin/realtime surface GitBot never speaks. What is here is the
 * transitive closure of the roots `src/codex-app-server.ts` types against:
 *
 *   ThreadItem, UserInput, ThreadStartedNotification, TurnStartedNotification,
 *   TurnCompletedNotification, ItemStartedNotification, ItemCompletedNotification,
 *   ErrorNotification, ServerRequestResolvedNotification,
 *   FileChangePatchUpdatedNotification, AgentMessageDeltaNotification,
 *   CommandExecutionOutputDeltaNotification, ReasoningSummaryTextDeltaNotification,
 *   ReasoningTextDeltaNotification, PlanDeltaNotification,
 *   ThreadStatusChangedNotification, ThreadTokenUsageUpdatedNotification,
 *   TurnPlanUpdatedNotification, McpServerStatusUpdatedNotification,
 *   TurnDiffUpdatedNotification
 *
 * Each declaration is verbatim from the generator, preceded by the generated
 * file it came from; the per-file `import type` lines are dropped because
 * everything they referred to is in this one file. Nothing else was edited.
 *
 * These describe what the SERVER PROMISES TO SEND. They are not a validator:
 * nothing on the wire is checked against them at runtime, and the binary can be
 * the user's own install rather than the pinned one (`resolveCodexBinary`
 * falls back to PATH). `WireItem` in codex-app-server.ts is how the mapping
 * code borrows the field names without claiming the fields are present.
 */

// AbsolutePathBuf.ts
/**
 * A path that is guaranteed to be absolute and normalized (though it is not
 * guaranteed to be canonicalized or exist on the filesystem).
 *
 * IMPORTANT: When deserializing an `AbsolutePathBuf`, a base path must be set
 * using [AbsolutePathBufGuard::new]. If no base path is set, the
 * deserialization will fail unless the path being deserialized is already
 * absolute.
 */
export type AbsolutePathBuf = string;

// v2/AgentMessageDelivery.ts
export type AgentMessageDelivery = "async";

// v2/AgentMessageDeltaNotification.ts
export type AgentMessageDeltaNotification = { threadId: string, turnId: string, itemId: string, delta: string, };

// AgentPath.ts
export type AgentPath = string;

// v2/AsyncUserInputQuestion.ts
export type AsyncUserInputQuestion = { title: string, options: Array<string> | null, };

// v2/ByteRange.ts
export type ByteRange = { start: number, end: number, };

// v2/CodexErrorInfo.ts
/**
 * This translation layer make sure that we expose codex error code in camel case.
 *
 * When an upstream HTTP status is available (for example, from the Responses API or a provider),
 * it is forwarded in `httpStatusCode` on the relevant `codexErrorInfo` variant.
 */
export type CodexErrorInfo = "contextWindowExceeded" | "sessionBudgetExceeded" | "usageLimitExceeded" | "rateLimitExceeded" | "serverOverloaded" | "cyberPolicy" | "misalignmentPolicyViolation" | { "httpConnectionFailed": { httpStatusCode: number | null, } } | { "responseStreamConnectionFailed": { httpStatusCode: number | null, } } | "internalServerError" | "unauthorized" | "badRequest" | "threadRollbackFailed" | "sandboxError" | { "responseStreamDisconnected": { httpStatusCode: number | null, } } | { "responseTooManyFailedAttempts": { httpStatusCode: number | null, } } | { "activeTurnNotSteerable": { turnKind: NonSteerableTurnKind, } } | "other";

// v2/CollabAgentState.ts
export type CollabAgentState = { status: CollabAgentStatus, message: string | null, };

// v2/CollabAgentStatus.ts
export type CollabAgentStatus = "pendingInit" | "running" | "interrupted" | "completed" | "errored" | "shutdown" | "notFound";

// v2/CollabAgentTool.ts
export type CollabAgentTool = "spawnAgent" | "sendInput" | "resumeAgent" | "wait" | "closeAgent" | "sendMessage" | "followupTask" | "interruptAgent" | "listAgents";

// v2/CollabAgentToolCallStatus.ts
export type CollabAgentToolCallStatus = "inProgress" | "completed" | "failed" | "interrupted";

// v2/CommandAction.ts
export type CommandAction = { "type": "read", command: string, name: string, path: LegacyAppPathString, } | { "type": "listFiles", command: string, path: string | null, } | { "type": "search", command: string, query: string | null, path: string | null, } | { "type": "unknown", command: string, };

// v2/CommandExecutionOutputDeltaNotification.ts
export type CommandExecutionOutputDeltaNotification = { threadId: string, turnId: string, itemId: string, delta: string, };

// v2/CommandExecutionSource.ts
export type CommandExecutionSource = "agent" | "userShell" | "unifiedExecStartup" | "unifiedExecInteraction";

// v2/CommandExecutionStatus.ts
export type CommandExecutionStatus = "inProgress" | "completed" | "failed" | "declined";

// v2/DynamicToolCallOutputContentItem.ts
export type DynamicToolCallOutputContentItem = { "type": "inputText", text: string, } | { "type": "inputImage", imageUrl: string, } | { "type": "inputAudio", audioUrl: string, };

// v2/DynamicToolCallStatus.ts
export type DynamicToolCallStatus = "inProgress" | "completed" | "failed";

// v2/ErrorNotification.ts
export type ErrorNotification = { error: TurnError, willRetry: boolean, threadId: string, turnId: string, };

// v2/FileChangePatchUpdatedNotification.ts
export type FileChangePatchUpdatedNotification = { threadId: string, turnId: string, itemId: string, changes: Array<FileUpdateChange>, };

// v2/FileUpdateChange.ts
export type FileUpdateChange = { path: string, kind: PatchChangeKind, diff: string, };

// FunctionCallOutputBody.ts
export type FunctionCallOutputBody = string | Array<FunctionCallOutputContentItem>;

// FunctionCallOutputContentItem.ts
/**
 * Responses API compatible content items that can be returned by a tool call.
 * This is a subset of ContentItem with the types we support as function call outputs.
 */
export type FunctionCallOutputContentItem = { "type": "input_text", text: string, } | { "type": "input_image", image_url: string, detail?: ImageDetail, } | { "type": "input_audio", audio_url: string, } | { "type": "encrypted_content", encrypted_content: string, };

// v2/GitInfo.ts
export type GitInfo = { sha: string | null, branch: string | null, originUrl: string | null, };

// v2/HookPromptFragment.ts
export type HookPromptFragment = { text: string, hookRunId: string, };

// ImageDetail.ts
export type ImageDetail = "auto" | "low" | "high" | "original";

// ImageGenerationFailure.ts
export type ImageGenerationFailure = { "type": "usageLimitExceeded", limitId: string, resetsAt: number | null, };

// ImageGenerationItem.ts
export type ImageGenerationItem = { id: string, status: string, revisedPrompt: string | null, result: string, transparentBackground?: boolean, failure: ImageGenerationFailure | null, savedPath?: AbsolutePathBuf, };

// v2/ItemCompletedNotification.ts
export type ItemCompletedNotification = { item: ThreadItem, threadId: string, turnId: string,
/**
 * Unix timestamp (in milliseconds) when this item lifecycle completed.
 */
completedAtMs: number, };

// v2/ItemStartedNotification.ts
export type ItemStartedNotification = { item: ThreadItem, threadId: string, turnId: string,
/**
 * Unix timestamp (in milliseconds) when this item lifecycle started.
 */
startedAtMs: number, };

// serde_json/JsonValue.ts
export type JsonValue = number | string | boolean | Array<JsonValue> | { [key in string]?: JsonValue } | null;

// LegacyAppPathString.ts
/**
 * A UTF-8 path for preserving raw path compatibility at the app-server API
 * boundary while Codex migrates to [`PathUri`].
 *
 * Supports storing arbitrary strings read from the API and converting to and
 * from [`PathUri`] using an explicitly selected native path convention.
 *
 * When converting from [`PathUri`], "native" refers to the supplied
 * [`PathConvention`], which may be foreign to the operating system running
 * this process. The inner string is private so path-producing code must use a
 * path conversion method instead of bypassing the intended conversion
 * boundary. Non-UTF-8 paths are converted to UTF-8 lossily because this API
 * value is serialized as a JSON string.
 *
 * Deserialization and [`Self::from_string`] accept any UTF-8 string without
 * interpreting or validating it. Use [`Self::from_string`] when a caller
 * already owns legacy app-server path text and needs to preserve its wire
 * spelling; use [`Self::from_path`], [`Self::from_abs_path`], or
 * [`Self::from_path_uri`] when converting an actual path value. Relative
 * path text remains valid until an operation such as [`Self::to_path_uri`]
 * requires an absolute path.
 */
export type LegacyAppPathString = string;

// v2/McpServerStartupFailureReason.ts
export type McpServerStartupFailureReason = "reauthenticationRequired";

// v2/McpServerStartupState.ts
export type McpServerStartupState = "starting" | "ready" | "failed" | "cancelled";

// v2/McpServerStatusUpdatedNotification.ts
export type McpServerStatusUpdatedNotification = { threadId: string | null, name: string, status: McpServerStartupState, error: string | null, failureReason: McpServerStartupFailureReason | null, };

// v2/McpToolCallAppContext.ts
export type McpToolCallAppContext = { connectorId: string, linkId: string | null, resourceUri: string | null, appName: string | null, actionName: string | null, };

// v2/McpToolCallError.ts
export type McpToolCallError = { message: string, };

// v2/McpToolCallResult.ts
export type McpToolCallResult = { content: Array<JsonValue>, structuredContent: JsonValue | null, _meta: JsonValue | null, };

// v2/McpToolCallStatus.ts
export type McpToolCallStatus = "inProgress" | "completed" | "failed";

// v2/MemoryCitation.ts
export type MemoryCitation = { entries: Array<MemoryCitationEntry>, threadIds: Array<string>, };

// v2/MemoryCitationEntry.ts
export type MemoryCitationEntry = { path: string, lineStart: number, lineEnd: number, note: string, };

// MessagePhase.ts
/**
 * Classifies an assistant message as interim commentary or final answer text.
 *
 * Providers do not emit this consistently, so callers must treat `None` as
 * "phase unknown" and keep compatibility behavior for legacy models.
 */
export type MessagePhase = "commentary" | "final_answer";

// v2/MisalignmentErrorDetails.ts
export type MisalignmentErrorDetails = {
/**
 * Open-ended classification; clients must accept categories added by Responses.
 */
errorType: string | null,
/**
 * A substantive localized explanation is required before offering continuation.
 */
detailedExplanation: string | null,
/**
 * Instruction to submit as the next turn's user input if continuation is confirmed.
 */
steer: MisalignmentSteer | null, };

// v2/MisalignmentSteer.ts
export type MisalignmentSteer = { message: string, };

// v2/NonSteerableTurnKind.ts
export type NonSteerableTurnKind = "review" | "compact";

// v2/PatchApplyStatus.ts
export type PatchApplyStatus = "inProgress" | "completed" | "failed" | "declined";

// v2/PatchChangeKind.ts
export type PatchChangeKind = { "type": "add" } | { "type": "delete" } | { "type": "update", move_path: string | null, };

// v2/PlanDeltaNotification.ts
/**
 * EXPERIMENTAL - proposed plan streaming deltas for plan items. Clients should
 * not assume concatenated deltas match the completed plan item content.
 */
export type PlanDeltaNotification = { threadId: string, turnId: string, itemId: string, delta: string, };

// ReasoningEffort.ts
/**
 * See https://platform.openai.com/docs/guides/reasoning?api-mode=responses#get-started-with-reasoning
 */
export type ReasoningEffort = string;

// v2/ReasoningSummaryTextDeltaNotification.ts
export type ReasoningSummaryTextDeltaNotification = { threadId: string, turnId: string, itemId: string, delta: string, summaryIndex: number, };

// v2/ReasoningTextDeltaNotification.ts
export type ReasoningTextDeltaNotification = { threadId: string, turnId: string, itemId: string, delta: string, contentIndex: number, };

// RequestId.ts
export type RequestId = string | number;

// v2/ServerRequestResolvedNotification.ts
export type ServerRequestResolvedNotification = { threadId: string, requestId: RequestId, };

// v2/SessionSource.ts
export type SessionSource = "cli" | "vscode" | "exec" | "appServer" | { "custom": string } | { "subAgent": SubAgentSource } | "unknown";

// SleepItem.ts
/**
 * Display item emitted by the interruptible `clock.sleep` tool.
 */
export type SleepItem = { id: string, durationMs: number, };

// v2/SubAgentActivityKind.ts
export type SubAgentActivityKind = "started" | "interacted" | "interrupted" | "completed";

// SubAgentSource.ts
export type SubAgentSource = "review" | "compact" | { "thread_spawn": { parent_thread_id: ThreadId, depth: number, agent_path: AgentPath | null, agent_nickname: string | null, agent_role: string | null, } } | "memory_consolidation" | { "other": string };

// v2/TextElement.ts
export type TextElement = {
/**
 * Byte range in the parent `text` buffer that this element occupies.
 */
byteRange: ByteRange,
/**
 * Optional human-readable placeholder for the element, displayed in the UI.
 */
placeholder: string | null, };

// v2/Thread.ts
export type Thread = {
/**
 * Identifier for this thread. Codex-generated thread IDs are UUIDv7.
 */
id: string,
/**
 * Current environments for a loaded thread, in priority order, primary first.
 * `null` means the thread is not loaded or the server does not expose its selection.
 * An empty list means no environments are selected. This does not report connection status.
 */
environments: Array<ThreadEnvironment> | null,
/**
 * Optional implementation-specific thread data.
 */
extra: ThreadExtra | null,
/**
 * Session id shared by threads that belong to the same session tree.
 */
sessionId: string,
/**
 * Source thread id when this thread was created by forking another thread.
 */
forkedFromId: string | null,
/**
 * The ID of the parent thread. This will only be set if this thread is a subagent.
 */
parentThreadId: string | null,
/**
 * Usually the first user message in the thread, if available.
 */
preview: string,
/**
 * Whether the thread is ephemeral and should not be materialized on disk.
 */
ephemeral: boolean,
/**
 * The independently persisted section selected for this thread, if any.
 */
section: ThreadSection | null,
/**
 * Unix timestamp in seconds when the thread entered its current section.
 */
sectionEnteredAt: number | null,
/**
 * Canonical project assignment owned by app-server, if any.
 */
projectId: string | null,
/**
 * Persisted thread history contract selected when this thread was created.
 */
historyMode: ThreadHistoryMode,
/**
 * Model provider used for this thread (for example, 'openai').
 */
modelProvider: string,
/**
 * Current configured model when loaded, otherwise the latest persisted model.
 * Null when unavailable. This is not per-turn execution telemetry.
 */
model: string | null,
/**
 * Current configured reasoning effort when loaded, otherwise the latest persisted effort.
 * Null when unset or unavailable. This is not per-turn execution telemetry.
 */
reasoningEffort: ReasoningEffort | null,
/**
 * Unix timestamp (in seconds) when the thread was created.
 */
createdAt: number,
/**
 * Unix timestamp (in seconds) when the thread was last updated.
 */
updatedAt: number,
/**
 * Unix timestamp (in seconds) used for thread recency ordering.
 */
recencyAt: number | null,
/**
 * Current runtime status for the thread.
 */
status: ThreadStatus,
/**
 * [UNSTABLE] Path to the thread on disk.
 */
path: string | null,
/**
 * Working directory captured for the thread.
 */
cwd: AbsolutePathBuf,
/**
 * Version of the CLI that created the thread.
 */
cliVersion: string,
/**
 * Originator recorded when the thread was created, independent of its current client or executor.
 * Null when the recorded originator is unavailable.
 */
originator: string | null,
/**
 * Origin of the thread (CLI, VSCode, codex exec, codex app-server, etc.).
 */
source: SessionSource,
/**
 * Whether the app server accepts direct turn input for this loaded thread.
 * `None` means the capability is unavailable, such as for an unloaded stored thread.
 */
canAcceptDirectInput: boolean | null,
/**
 * Optional analytics source classification for this thread.
 */
threadSource: ThreadSource | null,
/**
 * Optional random unique nickname assigned to an AgentControl-spawned sub-agent.
 */
agentNickname: string | null,
/**
 * Optional role (agent_role) assigned to an AgentControl-spawned sub-agent.
 */
agentRole: string | null,
/**
 * Optional Git metadata captured when the thread was created.
 */
gitInfo: GitInfo | null,
/**
 * Optional user-facing thread title.
 */
name: string | null,
/**
 * Saved Daybreak choice, independent of turn execution. Null if unset.
 */
daybreakEnabled: boolean | null,
/**
 * Only populated on `thread/resume`, `thread/rollback`, `thread/fork`, and `thread/read`
 * (when `includeTurns` is true) responses.
 * For all other responses and notifications returning a Thread,
 * the turns field will be an empty list.
 */
turns: Array<Turn>, };

// v2/ThreadActiveFlag.ts
export type ThreadActiveFlag = "waitingOnApproval" | "waitingOnUserInput";

// v2/ThreadEnvironment.ts
/**
 * An environment selected by a loaded thread, independent of connection status.
 */
export type ThreadEnvironment = { environmentId: string, cwd: LegacyAppPathString, runtimeWorkspaceRoots: Array<LegacyAppPathString>, };

// v2/ThreadExtra.ts
/**
 * Extra app-server data for a thread.
 */
export type ThreadExtra = Record<string, never>;

// v2/ThreadHistoryMode.ts
export type ThreadHistoryMode = "legacy" | "paginated";

// ThreadId.ts
/**
 * Identifier for a Codex thread.
 *
 * Codex-generated thread IDs are UUIDv7, and some use cases rely on that.
 */
export type ThreadId = string;

// v2/ThreadItem.ts
export type ThreadItem = { "type": "userMessage", id: string, clientId: string | null, content: Array<UserInput>, } | { "type": "hookPrompt", id: string, fragments: Array<HookPromptFragment>, } | { "type": "agentMessage", id: string, text: string, phase: MessagePhase | null, memoryCitation: MemoryCitation | null, delivery: AgentMessageDelivery | null, questions: Array<AsyncUserInputQuestion> | null, } | { "type": "functionCallOutput", id: string, name: string, namespace: string | null, output: FunctionCallOutputBody, } | { "type": "plan", id: string, text: string, } | { "type": "reasoning", id: string, summary: Array<string>, content: Array<string>, } | { "type": "commandExecution", id: string,
/**
 * Trusted first-party plugin id when this command resolves to one plugin script.
 */
pluginId: string | null,
/**
 * Safe plugin-relative path when this command resolves to one plugin script.
 */
scriptPath: string | null,
/**
 * The command to be executed.
 */
command: string,
/**
 * The command's working directory.
 */
cwd: LegacyAppPathString,
/**
 * Identifier for the underlying PTY process (when available).
 */
processId: string | null, source: CommandExecutionSource, status: CommandExecutionStatus,
/**
 * A best-effort parsing of the command to understand the action(s) it will perform.
 * This returns a list of CommandAction objects because a single shell command may
 * be composed of many commands piped together.
 */
commandActions: Array<CommandAction>,
/**
 * The command's output, aggregated from stdout and stderr.
 */
aggregatedOutput: string | null,
/**
 * The command's exit code.
 */
exitCode: number | null,
/**
 * The duration of the command execution in milliseconds.
 */
durationMs: number | null, } | { "type": "fileChange", id: string, changes: Array<FileUpdateChange>, status: PatchApplyStatus, } | { "type": "mcpToolCall", id: string, server: string, tool: string, status: McpToolCallStatus, arguments: JsonValue, appContext: McpToolCallAppContext | null,
/**
 * Deprecated: use `appContext.resourceUri` instead.
 */
mcpAppResourceUri?: string, pluginId: string | null, readOnlyHint: boolean | null, result: McpToolCallResult | null, error: McpToolCallError | null,
/**
 * The duration of the MCP tool call in milliseconds.
 */
durationMs: number | null, } | { "type": "dynamicToolCall", id: string, namespace: string | null, tool: string, arguments: JsonValue, status: DynamicToolCallStatus, contentItems: Array<DynamicToolCallOutputContentItem> | null, success: boolean | null,
/**
 * The duration of the dynamic tool call in milliseconds.
 */
durationMs: number | null, } | { "type": "collabAgentToolCall",
/**
 * Unique identifier for this collab tool call.
 */
id: string,
/**
 * Name of the collab tool that was invoked.
 */
tool: CollabAgentTool,
/**
 * Current status of the collab tool call.
 */
status: CollabAgentToolCallStatus,
/**
 * Thread ID of the agent issuing the collab request.
 */
senderThreadId: string,
/**
 * Thread ID of the receiving agent, when applicable. In case of spawn operation,
 * this corresponds to the newly spawned agent.
 */
receiverThreadIds: Array<string>,
/**
 * Prompt text sent as part of the collab tool call, when available.
 */
prompt: string | null,
/**
 * Model requested for the spawned agent, when applicable.
 */
model: string | null,
/**
 * Reasoning effort requested for the spawned agent, when applicable.
 */
reasoningEffort: ReasoningEffort | null,
/**
 * Last known status of the target agents, when available.
 */
agentsStates: { [key in string]?: CollabAgentState }, } | { "type": "subAgentActivity", id: string, kind: SubAgentActivityKind, agentThreadId: string, agentPath: string, } | { "type": "webSearch" } & WebSearchItem | { "type": "imageView", id: string, path: LegacyAppPathString, } | { "type": "sleep" } & SleepItem | { "type": "imageGeneration" } & ImageGenerationItem | { "type": "enteredReviewMode", id: string, review: string, } | { "type": "exitedReviewMode", id: string, review: string, } | { "type": "contextCompaction", id: string, };

// v2/ThreadSection.ts
/**
 * An independently persisted, user-visible thread section.
 */
export type ThreadSection = {
/**
 * Opaque UUIDv7 identity that remains stable when the section is renamed.
 */
id: string,
/**
 * The current user-visible section name.
 */
name: string,
/**
 * Optional appearance synchronized across clients.
 */
appearance: ThreadSectionAppearance | null, };

// v2/ThreadSectionAppearance.ts
/**
 * Extensible visual presentation for a custom thread section.
 */
export type ThreadSectionAppearance = { icon: string | null, color: string | null, };

// v2/ThreadSource.ts
export type ThreadSource = string;

// v2/ThreadStartedNotification.ts
export type ThreadStartedNotification = { thread: Thread, };

// v2/ThreadStatus.ts
export type ThreadStatus = { "type": "notLoaded" } | { "type": "idle" } | { "type": "systemError" } | { "type": "active", activeFlags: Array<ThreadActiveFlag>, };

// v2/ThreadStatusChangedNotification.ts
export type ThreadStatusChangedNotification = { threadId: string, status: ThreadStatus, };

// v2/ThreadTokenUsage.ts
export type ThreadTokenUsage = { total: TokenUsageBreakdown, last: TokenUsageBreakdown, modelContextWindow: number | null, };

// v2/ThreadTokenUsageUpdatedNotification.ts
export type ThreadTokenUsageUpdatedNotification = { threadId: string, turnId: string, tokenUsage: ThreadTokenUsage, };

// v2/TokenUsageBreakdown.ts
export type TokenUsageBreakdown = { totalTokens: number, inputTokens: number, cachedInputTokens: number, cacheWriteInputTokens: number, outputTokens: number, reasoningOutputTokens: number, };

// v2/Turn.ts
export type Turn = {
/**
 * Identifier for this turn. Codex-generated turn IDs are UUIDv7.
 */
id: string,
/**
 * Thread items currently included in this turn payload.
 */
items: Array<ThreadItem>,
/**
 * Describes how much of `items` has been loaded for this turn.
 */
itemsView: TurnItemsView, status: TurnStatus,
/**
 * Only populated when the Turn's status is failed.
 */
error: TurnError | null,
/**
 * Unix timestamp (in seconds) when the turn started.
 */
startedAt: number | null,
/**
 * Unix timestamp (in seconds) when the turn completed.
 */
completedAt: number | null,
/**
 * Duration between turn start and completion in milliseconds, if known.
 */
durationMs: number | null, };

// v2/TurnCompletedNotification.ts
export type TurnCompletedNotification = { threadId: string, turn: Turn, };

// v2/TurnDiffUpdatedNotification.ts
/**
 * Notification that the turn-level unified diff has changed.
 * Contains the latest aggregated diff across all file changes in the turn.
 */
export type TurnDiffUpdatedNotification = { threadId: string, turnId: string, diff: string, };

// v2/TurnError.ts
export type TurnError = { message: string, codexErrorInfo: CodexErrorInfo | null, additionalDetails: string | null,
/**
 * Optional public explanation and continuation instruction for a misalignment block.
 */
misalignment: MisalignmentErrorDetails | null, };

// v2/TurnItemsView.ts
export type TurnItemsView = "notLoaded" | "summary" | "full";

// v2/TurnPlanStep.ts
export type TurnPlanStep = { step: string, status: TurnPlanStepStatus, };

// v2/TurnPlanStepStatus.ts
export type TurnPlanStepStatus = "pending" | "inProgress" | "completed";

// v2/TurnPlanUpdatedNotification.ts
export type TurnPlanUpdatedNotification = { threadId: string, turnId: string, explanation: string | null, plan: Array<TurnPlanStep>, };

// v2/TurnStartedNotification.ts
export type TurnStartedNotification = { threadId: string, turn: Turn, };

// v2/TurnStatus.ts
export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

// v2/UserInput.ts
export type UserInput = { "type": "text", text: string,
/**
 * UI-defined spans within `text` used to render or persist special elements.
 */
text_elements: Array<TextElement>, } | { "type": "image", detail?: ImageDetail, url: string, } | { "type": "localImage", detail?: ImageDetail, path: string, } | { "type": "audio", url: string, } | { "type": "localAudio", path: string, } | { "type": "skill", name: string, path: string, } | { "type": "mention", name: string, path: string, };

// v2/WebSearchAction.ts
export type WebSearchAction = { "type": "search", query: string | null, queries: Array<string> | null, } | { "type": "openPage", url: string | null, } | { "type": "findInPage", url: string | null, pattern: string | null, } | { "type": "other" };

// WebSearchItem.ts
export type WebSearchItem = { id: string, query: string, action: WebSearchAction | null,
/**
 * Structured search results returned out-of-band by standalone web search.
 *
 * These stay as opaque JSON at the extension/app-server boundary so new
 * result fields and result types can pass through without a Codex release.
 */
results: Array<JsonValue> | null, };

