import { bbRemoteWorkspacesError } from "./errors.js";

const PLAIN_SHELL_ARGUMENT = /^[A-Za-z0-9_@%+=:,./-]+$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export function assertCommandArgument(value: string): void {
  if (value.length === 0) return;
  if (CONTROL_CHARACTER.test(value)) {
    throw bbRemoteWorkspacesError(
      "invalid_command_argument",
      "Command arguments may not contain control characters.",
    );
  }
}

export function quoteShellArgument(value: string): string {
  assertCommandArgument(value);
  if (value.length > 0 && PLAIN_SHELL_ARGUMENT.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function formatCommand(args: readonly string[]): string {
  if (args.length === 0) {
    throw bbRemoteWorkspacesError("empty_command", "Cannot execute an empty command.");
  }
  return args.map(quoteShellArgument).join(" ");
}
