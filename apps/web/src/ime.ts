/** Runs an Enter action without consuming the Enter key that confirms an IME candidate. */
export function handleImeSafeEnter(event: {
  key: string;
  isComposing: boolean;
  keyCode: number;
  preventDefault: () => void;
}, action: () => void): boolean {
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return false;
  event.preventDefault();
  action();
  return true;
}
