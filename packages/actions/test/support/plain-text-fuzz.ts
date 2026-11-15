/** Seeded generator of legacy plain-text lines: every Markdown block starter and inline trigger, joined at random, with edge spaces. */
export const plainTextTokens = [
  "#", "##", "###", "-", "+", "*", "1.", "2023.", "3)", ">", "---", "===", "~~~", "```", "|", "[", "]", "(", ")", "<", ">", "&", "!", "\\", "_", "*", "~", "=", "@", ":",
  "www.", "http://", "mailto:", "[[", "]]", "`", "[link](http://x.com)", "www.example.com/x_y_z", "<https://auto.link>", "a@b.c", "&amp;", "&#60;", "![a](b)", "@{x}", "[[a|b]]", "==", "**", "__", "|---|", "    ",
  "word", "text", "legacy", "The", "quick", "12", "x_y_z", "ABC",
];
export function seededRandom(seed: number) {
  let state = seed;
  return () => { state = state + 0x6d2b79f5 | 0; let t = Math.imul(state ^ state >>> 15, 1 | state); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
export function plainTextLines(count: number, seed = 0x5eed) {
  const random = seededRandom(seed);
  const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)]!;
  const lines: string[] = [];
  for (let index = 0; index < count; index++) {
    const parts: string[] = [];
    const length = 1 + Math.floor(random() * 6);
    for (let part = 0; part < length; part++) parts.push(pick(plainTextTokens), pick(["", "", " ", "  "]));
    let line = parts.join("");
    if (random() < 0.2) line = pick([" ", "  ", "    ", "\t"]) + line;
    if (random() < 0.2) line += pick([" ", "  "]);
    if (random() < 0.15) line = line + "\n" + pick(plainTextTokens) + " " + pick(plainTextTokens);
    if (line.trim()) lines.push(line);
  }
  return lines;
}
