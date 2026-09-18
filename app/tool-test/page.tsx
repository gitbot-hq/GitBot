"use client";

import {
  IconCheck,
  IconChevronDown,
  IconFileSearch,
  IconRefresh,
  IconLoader2,
  IconTerminal2,
} from "@tabler/icons-react";
import { useState } from "react";
import "./tool-test.css";

type PreviewTool = {
  detail: string;
  icon: typeof IconTerminal2;
  label: string;
};

const previewTools: PreviewTool[] = [
  { label: "Searching files", detail: "rg --files app/components", icon: IconFileSearch },
  { label: "Running command", detail: "npm run lint", icon: IconTerminal2 },
];

// 0.5s: a calm chat-turn receipt, with the active tool work as the focal point.
export default function ToolTestPage() {
  const [expanded, setExpanded] = useState(false);
  const [complete, setComplete] = useState(false);

  function resetPreview() {
    setExpanded(false);
    setComplete(false);
  }

  return (
    <main className="tool-test">
      <section className="tool-test-card" aria-labelledby="tool-test-title">
        <p className="tool-test-kicker">GitBot UI preview</p>
        <h1 id="tool-test-title">Tool activity</h1>
        <p className="tool-test-intro">
          A small, interactive preview for checking the chat&apos;s work states.
        </p>
        <p className={complete ? "tool-test-status is-complete" : "tool-test-status"}>
          {complete ? (
            <IconCheck size={15} aria-hidden="true" />
          ) : (
            <IconLoader2 size={15} aria-hidden="true" />
          )}
          <span>{complete ? "All clear" : "Working"}</span>
          <output>{complete ? "2.0s" : "0.8s"}</output>
        </p>

        <div className="tool-test-turn" aria-live="polite">
          <p className="tool-test-copy">I&apos;m checking the project and verifying the change.</p>
          <div className="tool-test-tools">
            {previewTools.map(({ label, detail, icon: Icon }) => (
              <div className="tool-test-row" key={label}>
                <Icon size={16} aria-hidden="true" />
                <span>{label}</span>
                <code>{detail}</code>
              </div>
            ))}
          </div>

          <button
            type="button"
            className="tool-test-details"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
          >
            <span>2 tool calls</span>
            <IconChevronDown className={expanded ? "is-open" : ""} size={16} aria-hidden="true" />
          </button>
          {expanded && (
            <pre className="tool-test-output">Found 18 components{`\n`}Lint passed with no errors</pre>
          )}
        </div>

        <div className="tool-test-actions">
          <button
            type="button"
            className="tool-test-complete"
            onClick={() => setComplete((value) => !value)}
            aria-pressed={complete}
          >
            <IconCheck size={16} aria-hidden="true" />
            {complete ? "Marked complete · 2s" : "Mark preview complete"}
          </button>
          {(expanded || complete) && (
            <button type="button" className="tool-test-reset" onClick={resetPreview}>
              <IconRefresh size={15} aria-hidden="true" />
              Reset
            </button>
          )}
        </div>
      </section>
    </main>
  );
}
