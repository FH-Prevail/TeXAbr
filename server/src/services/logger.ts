// One-line JSON logger to stdout. systemd-journald captures it in production;
// in dev it streams to the terminal. No external dependency.
//
// `getMinLevel` is a thunk so the level can change at runtime when an admin
// edits logging.level in the panel — we don't capture a value at construction.

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bound: Record<string, unknown>): Logger;
}

export function makeLogger(getMinLevel: () => LogLevel): Logger {
  function emit(level: LogLevel, msg: string, fields: Record<string, unknown> | undefined, bound: Record<string, unknown>) {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[getMinLevel()]) return;
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...bound,
      ...(fields ?? {}),
    };
    const dest = level === "error" || level === "warn" ? process.stderr : process.stdout;
    dest.write(JSON.stringify(entry, errorReplacer) + "\n");
  }
  function build(bound: Record<string, unknown>): Logger {
    return {
      debug: (msg, f) => emit("debug", msg, f, bound),
      info:  (msg, f) => emit("info", msg, f, bound),
      warn:  (msg, f) => emit("warn", msg, f, bound),
      error: (msg, f) => emit("error", msg, f, bound),
      child: (b) => build({ ...bound, ...b }),
    };
  }
  return build({});
}

// Default Error.toJSON() drops message + stack. Inline them so logs are useful.
function errorReplacer(_key: string, value: unknown) {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}
