type LogLevel = "info" | "warn" | "error";

interface LogEntry {
  level: LogLevel;
  action: string;
  [key: string]: unknown;
}

// Emits structured JSON log entries for Cloudflare Workers log querying.
function log(entry: LogEntry): void {
  const output = { ...entry, ts: new Date().toISOString() };
  switch (entry.level) {
    case "error":
      console.error(JSON.stringify(output));
      break;
    case "warn":
      console.warn(JSON.stringify(output));
      break;
    default:
      console.log(JSON.stringify(output));
  }
}

export function logInfo(action: string, data: Record<string, unknown> = {}): void {
  log({ level: "info", action, ...data });
}

export function logWarn(action: string, data: Record<string, unknown> = {}): void {
  log({ level: "warn", action, ...data });
}

export function logError(action: string, error: unknown, data: Record<string, unknown> = {}): void {
  const errMsg = error instanceof Error ? error.message : String(error);
  const errStack = error instanceof Error ? error.stack : undefined;
  log({ level: "error", action, error: errMsg, stack: errStack, ...data });
}
