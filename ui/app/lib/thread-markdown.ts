/** Message text is already filtered by the chat's history renderer. */
export function threadMarkdown(title: string, messages: { role: string; text: string }[]): string {
  const heading = title.replace(/[\r\n]+/g, " ").replace(/([\\`*_{}\[\]()#+.!<>|~-])/g, "\\$1");
  const conversation = messages
    .filter((message) => message.text.trim())
    .map((message) => `## ${message.role === "user" ? "User" : "Assistant"}\n\n${message.text}`)
    .join("\n\n---\n\n");
  return `# ${heading}\n\n_Exported from GitBot. Tool calls are omitted._\n\n${conversation}\n`;
}

export function threadMarkdownFilename(title: string): string {
  const name = title.normalize("NFKC").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .slice(0, 100).trim().replace(/[. ]+$/g, "") || "thread";
  return `gitbot-${name}.md`;
}
