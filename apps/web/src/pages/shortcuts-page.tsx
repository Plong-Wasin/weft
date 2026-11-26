import React from "react";
import { translate } from "@weft/shared";
import { formatShortcut, isMacPlatform, shortcuts } from "../command-palette-model";

/** The keys and what they do, built from the same registry the palette uses. The shortcuts dialog shows it too. */
export function ShortcutTable() {
  const mac = isMacPlatform(navigator.userAgent);
  return <table className="w-full border-collapse text-14">
    <thead><tr className="border-b border-border text-left text-12 font-medium text-muted-foreground">
      <th scope="col" className="py-2 pr-4 font-medium">{translate("shortcuts.keys")}</th>
      <th scope="col" className="py-2 font-medium">{translate("shortcuts.action")}</th>
    </tr></thead>
    <tbody>{shortcuts.map((shortcut) => <tr key={shortcut.describe} className="border-b border-border">
      <td className="py-2.5 pr-4 align-top whitespace-nowrap"><kbd className="rounded border border-border bg-card px-1.5 py-0.5 font-mono text-12">{formatShortcut(shortcut.keys, mac)}</kbd></td>
      <td className="py-2.5 align-top">{translate(shortcut.describe)}</td>
    </tr>)}</tbody>
  </table>;
}

/** Lists every keyboard shortcut the app answers to. */
export function ShortcutsPage() {
  return <main className="mx-auto w-full max-w-[720px] p-4">
    <h1 className="text-20 font-semibold">{translate("shortcuts.title")}</h1>
    <p className="mt-1 text-14 text-muted-foreground">{translate("shortcuts.intro")}</p>
    <div className="mt-4"><ShortcutTable /></div>
  </main>;
}
