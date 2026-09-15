import { Schema } from "effect";

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /Bearer\s+\S+/gi,
  /exe[01]\.[A-Za-z0-9._~-]+/g,
  /(--(?:join|machine)-code(?:=|\s+))\S+/gi,
  /(authorization["']?\s*[:=]\s*["']?)[^\s"']+/gi,
];

export function redactSecrets(value: string, maxLength = 800): string {
  let redacted = value;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (_match, prefix?: string) =>
      prefix === undefined ? "[REDACTED]" : `${prefix}[REDACTED]`,
    );
  }
  return redacted.length <= maxLength ? redacted : `${redacted.slice(0, maxLength)}…`;
}

export function errorMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

export class BbRemoteWorkspacesError extends Schema.TaggedError<BbRemoteWorkspacesError>()("BbRemoteWorkspacesError", {
  code: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
}) {}

export function bbRemoteWorkspacesError(code: string, message: string, retryable = false): BbRemoteWorkspacesError {
  return new BbRemoteWorkspacesError({ code, message: redactSecrets(message), retryable });
}

export function asBbRemoteWorkspacesError(error: unknown, fallbackCode: string): BbRemoteWorkspacesError {
  return error instanceof BbRemoteWorkspacesError ? error : bbRemoteWorkspacesError(fallbackCode, errorMessage(error));
}
