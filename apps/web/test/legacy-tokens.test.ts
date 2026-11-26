import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

// The Plane-era token set and its utilities are retired: the app speaks shadcn's roles only.
const src = join(import.meta.dir, "../src");
const files = (readdirSync(src, { recursive: true }) as string[]).filter((name) => /\.(tsx?|css)$/.test(name)).map((name) => join(src, name));

const legacyToken = /--(?:bg|txt|brand|neutral|red|green|amber|label|priority|alpha|scrollbar|shadow-menu|radius-(?:control|row|card|dialog)|border-(?:subtle|strong|accent|success|danger|warning|color|disabled|inverse|width)|color-(?:canvas|surface|layer|success|warning|danger|link|subtle|strong))(?![a-z])[\w-]*/g;
const legacyColor = "canvas|surface-[12]|layer-[\\w-]+|accent-(?:primary|subtle|text|strong)[\\w-]*|success-(?:primary|subtle|text|strong)|warning-(?:primary|subtle|text|strong)|danger-(?:primary|subtle|text|strong)[\\w-]*|backdrop|inverse|tertiary|placeholder|disabled|on-color|link|subtle(?:-1)?|strong(?:-1)?";
const legacyUtility = new RegExp(`(?<![\\w-])(?:bg|text|border(?:-[trblxy])?|ring|outline|fill|stroke|divide)-(?:${legacyColor})(?![\\w-])`, "g");
const legacyClass = /(?<![\w-])(?:card-surface|inset-row-hover|group-band|quiet-divider)(?![\w-])/g;
const legacyButtonClass = new Set(["primary", "secondary", "danger", "ghost"]);

/** Whole class tokens such as `secondary` inside a className attribute or a class constant. */
function buttonClassNames(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const literals = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && /[!=]==/.test(node.operatorToken.getText())) return;
    if (ts.isConditionalExpression(node)) { literals(node.whenTrue); literals(node.whenFalse); return; }
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      found.push(...node.text.split(/\s+/).filter((word) => legacyButtonClass.has(word)));
      return;
    }
    ts.forEachChild(node, literals);
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && /className$/i.test(node.name.getText()) && node.initializer) literals(node.initializer);
    else if (ts.isVariableDeclaration(node) && /class(Name)?$/i.test(node.name.getText()) && node.initializer) literals(node.initializer);
    else ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function offences(pattern: RegExp): string[] {
  return files.flatMap((file) => [...readFileSync(file, "utf8").matchAll(pattern)].map((match) => `${relative(src, file)}: ${match[0]}`));
}

test("no legacy token is defined or read in src", () => {
  expect(offences(legacyToken)).toEqual([]);
});

test("no legacy colour utility is used in src", () => {
  expect(offences(legacyUtility)).toEqual([]);
});

test("no legacy component class is defined or used in src", () => {
  expect(offences(legacyClass)).toEqual([]);
  expect(offences(/(?<![\w)])\.(?:primary|secondary|danger|ghost)(?=\s*[{:,])/g).filter((hit) => hit.includes(".css"))).toEqual([]);
  expect(files.filter((file) => file.endsWith(".tsx")).flatMap((file) => buttonClassNames(file, readFileSync(file, "utf8")).map((word) => `${relative(src, file)}: ${word}`))).toEqual([]);
});

test("text-primary and text-secondary mean what shadcn means", () => {
  const style = readFileSync(join(src, "style.css"), "utf8");
  expect(style).toContain("--color-primary: var(--primary);");
  expect(style).toContain("--color-secondary: var(--secondary);");
  expect(style).not.toMatch(/@utility\s+bg-(primary|secondary)/);
});
