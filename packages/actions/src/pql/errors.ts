import { ActionError } from "../members";

/** A query problem with the 0-based character offset it points at. The message carries both, so every caller (UI, AI, CLI) can show it as is. */
export class PqlError extends ActionError {
  constructor(readonly position: number, readonly reason: string) {
    super(`Invalid query at position ${position}: ${reason}`, 400);
  }
}
