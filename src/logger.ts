/**
 * Minimal structured JSON-line logger. One log call = one JSON object on stdout
 * (or stderr for errors), so Railway/aggregators can parse it. This is the
 * observability layer (decision 8); a Postgres telemetry sink can wrap it later.
 */

export type LogFields = Record<string, unknown>;

export interface Logger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Derive a logger that stamps every line with extra fields (e.g. item number). */
  child(fields: LogFields): Logger;
}

type Sink = (line: string) => void;

const write = (
  base: LogFields,
  sinks: { out: Sink; err: Sink },
  level: "info" | "warn" | "error",
  msg: string,
  fields?: LogFields,
): void => {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...base, ...fields });
  (level === "error" ? sinks.err : sinks.out)(line);
};

export const createLogger = (
  base: LogFields = {},
  sinks: { out: Sink; err: Sink } = {
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  },
): Logger => ({
  info: (msg, fields) => write(base, sinks, "info", msg, fields),
  warn: (msg, fields) => write(base, sinks, "warn", msg, fields),
  error: (msg, fields) => write(base, sinks, "error", msg, fields),
  child: (fields) => createLogger({ ...base, ...fields }, sinks),
});
