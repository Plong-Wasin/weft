/** What the Link form saves: the text as typed, with https:// added when it names no scheme (www.example.com). Empty text stays empty. */
export function normalizeLinkUrl(value: string): string {
  const text = value.trim();
  if (!text) return "";
  // A scheme is "letters:" not followed by a port number, so localhost:3000 still gets https://.
  const hasScheme = /^[a-z][a-z0-9+.-]*:(?!\d+(\/|$))/i.test(text);
  if (hasScheme) return text;
  return `https://${text.replace(/^\/\//, "")}`;
}
