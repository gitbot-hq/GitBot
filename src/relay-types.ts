// Frames sent from relay → GITBOT (over WebSocket)
export type RelayToGitbotFrame =
  | { type: "registered" }
  | { type: "register_error"; reason: string }
  | { requestId: string; type: "request"; method: string; path: string; headers: Record<string, string>; body: string }

// Frames sent from GITBOT → relay (over WebSocket)
export type GitbotToRelayFrame =
  | { type: "register"; token: string }
  | { requestId: string; type: "response_start"; statusCode: number; headers: Record<string, string> }
  | { requestId: string; type: "data"; chunk: string }
  | { requestId: string; type: "end" }
  | { requestId: string; type: "error"; message: string }
  | { type: "push_notification"; title: string; body: string; data: Record<string, unknown> }
