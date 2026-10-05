import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { mkdtempSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  askUserQuestionLabel,
  isAskUserQuestion,
  parseAskUserQuestion,
  withAskAnswers,
} from "../src/ask-user-question";
import { approvalLabel } from "../src/child-approvals";
import { formatMessage, permissionRequest } from "../src/start-claude-code";
import {
  createThread,
  JARVIS_BOT_ID,
  jarvisDir,
} from "../src/bot-store";
import { startChildThread } from "../src/jarvis";
import { addProject } from "../src/project-index";
import {
  shouldAutoApprove,
  type IRequest,
  type IResponse,
  type PermissionMode,
  type SessionStore,
} from "../src/server-common";
import { handleRequest } from "../src/server";
import { agentRunners } from "../src/turns";

const ALL_AGENTS = ["claude-code", "opencode", "codex"];

// A stub at the agent seam: turns start, nothing is spawned.
const realRunners = { ...agentRunners };
let runs: SessionStore[] = [];
for (const agent of Object.keys(agentRunners) as SessionStore["agent"][]) {
  agentRunners[agent] = async (store) => {
    runs.push(store);
    store.status = "done";
  };
}
afterEach(() => { runs = []; });
after(() => { Object.assign(agentRunners, realRunners); });

/** A tool input in AskUserQuestion's own schema. */
const askInput = (over: Record<string, unknown> = {}) => ({
  questions: [
    {
      question: "Which library should we use for date formatting?",
      header: "Library",
      options: [
        { label: "date-fns", description: "Small, tree-shakeable." },
        { label: "Luxon", description: "Rich time zone support." },
      ],
    },
  ],
  ...over,
});

// --- Parsing ---

test("parseAskUserQuestion reads the tool's schema, defaulting multiSelect", () => {
  const parsed = parseAskUserQuestion(askInput());
  assert.deepEqual(parsed, [{
    header: "Library",
    question: "Which library should we use for date formatting?",
    multiSelect: false,
    options: [
      { label: "date-fns", description: "Small, tree-shakeable." },
      { label: "Luxon", description: "Rich time zone support." },
    ],
  }]);
  assert.equal(parseAskUserQuestion(askInput({
    questions: [{ ...askInput().questions[0], multiSelect: true }],
  }))![0].multiSelect, true);
});

test("parseAskUserQuestion falls back to the question when there is no header", () => {
  const input = { questions: [{ question: "Ship it?", options: [{ label: "Yes" }, { label: "No" }] }] };
  const parsed = parseAskUserQuestion(input)!;
  assert.equal(parsed[0].header, "Ship it?");
  // A missing description is empty, not undefined: the card renders a string.
  assert.deepEqual(parsed[0].options, [
    { label: "Yes", description: "" },
    { label: "No", description: "" },
  ]);
});

test("parseAskUserQuestion returns null for anything that is not a question", () => {
  const notQuestions: unknown[] = [
    undefined, null, "AskUserQuestion", 42, {},
    { questions: [] },
    { questions: "nope" },
    { questions: [{ header: "No question text", options: [{ label: "a" }] }] },
    // Nothing to pick: would render a card with no options.
    { questions: [{ question: "Pick one", options: [] }] },
    { questions: [{ question: "Pick one", options: [{ description: "no label" }] }] },
    // A real tool input that happens past here must not be mistaken for one.
    { command: "npm test", description: "Run the tests" },
  ];
  for (const input of notQuestions) {
    assert.equal(parseAskUserQuestion(input), null, JSON.stringify(input));
  }
});

test("isAskUserQuestion needs both the tool name and a question-shaped input", () => {
  assert.equal(isAskUserQuestion("AskUserQuestion", askInput()), true);
  assert.equal(isAskUserQuestion("Bash", askInput()), false);
  assert.equal(isAskUserQuestion("AskUserQuestion", { command: "ls" }), false);
});

// --- What the browser is sent ---
// The chat does no parsing of its own: a question card is drawn when, and only
// when, the permission_request event carries `questions`. The same payload is
// stored and replayed, so a rejoined turn draws the same card.

test("a permission_request carries an AskUserQuestion already parsed", () => {
  const ev = permissionRequest("tu-1", "AskUserQuestion", askInput());
  assert.deepEqual(ev.questions, parseAskUserQuestion(askInput()));
  // The raw input rides along: approving still answers through updatedInput.
  assert.deepEqual(ev, {
    toolUseID: "tu-1",
    toolName: "AskUserQuestion",
    input: askInput(),
    questions: ev.questions,
  });
});

test("a permission_request omits questions for anything that is not one", () => {
  // Another tool, and a question whose input does not parse: both must fall
  // back to the plain approval card, which is the absence of the field.
  for (const [toolName, input] of [
    ["Bash", { command: "ls" }],
    ["AskUserQuestion", { command: "ls" }],
    ["AskUserQuestion", { questions: [] }],
    ["AskUserQuestion", askInput({ questions: [{ question: "Why?", options: [] }] })],
  ] as const) {
    const ev = permissionRequest("tu-2", toolName, input);
    assert.equal("questions" in ev, false, `${toolName} ${JSON.stringify(input)}`);
  }
});

// --- The answer the SDK reads ---

test("withAskAnswers keys answers by question text and comma-joins a multi-select", () => {
  const input = {
    questions: [
      askInput().questions[0],
      {
        question: "Which features do you want to enable?",
        header: "Features",
        multiSelect: true,
        options: [{ label: "Logs" }, { label: "Metrics" }, { label: "Traces" }],
      },
    ],
  };
  const out = withAskAnswers(input, {
    "Which library should we use for date formatting?": ["Luxon"],
    "Which features do you want to enable?": ["Logs", "Traces"],
  });
  assert.deepEqual(out.answers, {
    "Which library should we use for date formatting?": "Luxon",
    "Which features do you want to enable?": "Logs, Traces",
  });
  // The rest of the input survives: the tool echoes the questions back too.
  assert.deepEqual((out as any).questions, input.questions);
});

test("withAskAnswers keeps free text, drops blanks, and ignores unknown questions", () => {
  const out = withAskAnswers(askInput(), {
    "Which library should we use for date formatting?": ["  Temporal, once it ships  "],
    "A question that was never asked": ["ignored"],
  });
  assert.deepEqual(out.answers, {
    "Which library should we use for date formatting?": "Temporal, once it ships",
  });

  // Answering nothing is an empty map, not a missing key: the tool reads
  // `answers` off its own input and must find something there.
  assert.deepEqual(withAskAnswers(askInput(), {}).answers, {});
  assert.deepEqual(withAskAnswers(askInput(), {
    "Which library should we use for date formatting?": ["", "   "],
  }).answers, {});
});

// --- No permission mode may answer it for the user ---

test("AskUserQuestion is never auto-approved, in any mode", () => {
  for (const mode of ["ask-permissions", "allow-all-edits", "yolo"] as PermissionMode[]) {
    assert.equal(shouldAutoApprove("claude-code", "AskUserQuestion", mode), false, mode);
  }
  // Sanity: yolo does wave other tools through, so the check above means something.
  assert.equal(shouldAutoApprove("claude-code", "Bash", "yolo"), true);
});

// --- How it reads elsewhere in the UI ---

test("a question reads as what was asked, not as a blob of JSON", () => {
  assert.equal(
    askUserQuestionLabel(askInput()),
    "Which library should we use for date formatting?",
  );
  assert.equal(askUserQuestionLabel({ command: "ls" }), "AskUserQuestion");

  // The tool chip, live and replayed from the transcript.
  const event = formatMessage({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "AskUserQuestion", input: askInput() }] },
  } as any) as Record<string, unknown>;
  assert.equal(event.tool_name, "AskUserQuestion");
  assert.equal(event.tool_input, "Which library should we use for date formatting?");

  // A Jarvis child's approval row.
  assert.equal(
    approvalLabel("AskUserQuestion", askInput()),
    "Which library should we use for date formatting?",
  );
  assert.equal(approvalLabel("Bash", { command: "npm test" }), "npm test");
});

// --- End to end through POST /sessions/:id/permission ---

async function request(method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  const req = Object.assign(new EventEmitter(), { method, url, headers: {} }) as unknown as IRequest;
  let status = 0;
  let out = "";
  const res: IResponse = {
    headersSent: false,
    writableEnded: false,
    writeHead(code) { status = code; },
    write() {},
    end(chunk) { out = chunk ?? ""; },
  };
  const done = handleRequest(req, res, ALL_AGENTS, tmpdir());
  setImmediate(() => {
    if (body !== undefined) (req as unknown as EventEmitter).emit("data", JSON.stringify(body));
    (req as unknown as EventEmitter).emit("end");
  });
  await done;
  return { status, body: JSON.parse(out || "{}") };
}

/** A running claude-code session with one pending approval, and what it resolved with. */
function sessionAsking(toolName: string, input: unknown) {
  const jarvis = createThread(JARVIS_BOT_ID, jarvisDir(), undefined, "chat", "claude-code");
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "gitbot-ask-")));
  const added = addProject(folder);
  assert.ok(added.ok);
  const started = startChildThread(jarvis.id, { agent: "claude-code", project: added.project.id, message: "go" }, ALL_AGENTS);
  assert.ok(started.ok, JSON.stringify(started));
  const store = runs[runs.length - 1];
  const resolved: any[] = [];
  store.pendingPermissions.set("tu-ask", {
    resolve: (r) => resolved.push(r),
    input,
    toolName,
    toolUseID: "tu-ask",
  });
  return { store, resolved };
}

test("answering a question allows the tool with the answers written into its input", async () => {
  const { store, resolved } = sessionAsking("AskUserQuestion", askInput());
  const res = await request("POST", `/sessions/${store.gitbotId}/permission`, {
    toolUseID: "tu-ask",
    approved: true,
    answers: { "Which library should we use for date formatting?": ["date-fns"] },
  });
  assert.equal(res.status, 200);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].behavior, "allow");
  // The answer travels as updatedInput — the tool reads it back out of its own
  // input — and the questions are still there beside it.
  assert.deepEqual(resolved[0].updatedInput.answers, {
    "Which library should we use for date formatting?": "date-fns",
  });
  assert.ok(Array.isArray(resolved[0].updatedInput.questions));
  assert.equal(store.pendingPermissions.size, 0);
});

test("skipping a question denies it with a reason that says so", async () => {
  const { resolved, store } = sessionAsking("AskUserQuestion", askInput());
  await request("POST", `/sessions/${store.gitbotId}/permission`, { toolUseID: "tu-ask", approved: false });
  assert.deepEqual(resolved, [{ behavior: "deny", message: "User declined to answer the questions" }]);
});

test("answers are ignored for an ordinary tool, which still allows as before", async () => {
  const { store, resolved } = sessionAsking("Bash", { command: "npm test" });
  await request("POST", `/sessions/${store.gitbotId}/permission`, {
    toolUseID: "tu-ask",
    approved: true,
    answers: { "Which library?": ["date-fns"] },
  });
  assert.deepEqual(resolved, [{ behavior: "allow", updatedInput: { command: "npm test" } }]);

  const denied = sessionAsking("Bash", { command: "rm -rf /" });
  await request("POST", `/sessions/${denied.store.gitbotId}/permission`, { toolUseID: "tu-ask", approved: false });
  assert.deepEqual(denied.resolved, [{ behavior: "deny", message: "User denied" }]);
});

test("allowing a question with no answers sent still carries an answers map", async () => {
  // A client that knows nothing of questions can still press Allow; the tool
  // must find `answers` on its input rather than an undefined.
  const { store, resolved } = sessionAsking("AskUserQuestion", askInput());
  await request("POST", `/sessions/${store.gitbotId}/permission`, {
    toolUseID: "tu-ask",
    approved: true,
    answers: {},
  });
  assert.deepEqual(resolved[0].updatedInput.answers, {});
});
