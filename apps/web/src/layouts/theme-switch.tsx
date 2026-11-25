import React from "react";
import { translate } from "@weft/shared";
import { themes, useTheme } from "../theme";
import { Select, SelectContent, SelectItem, SelectItemText, SelectTrigger, SelectValue } from "../ui/select";

export function ThemeSwitch() {
  const [theme, setTheme] = useTheme();
  return <label className="flex items-center gap-1.5">{translate("theme.label")}
    <Select value={theme} items={themes.map((value) => ({ value, label: translate(`theme.${value}`) }))} onValueChange={(value: string | null) => { if (typeof value === "string") setTheme(value as (typeof themes)[number]); }}>
      <SelectTrigger aria-label={translate("theme.label")} className="w-auto pointer-coarse:min-h-11 pointer-coarse:min-w-11"><SelectValue /></SelectTrigger>
      <SelectContent>{themes.map((value) => <SelectItem key={value} value={value}><SelectItemText>{translate(`theme.${value}`)}</SelectItemText></SelectItem>)}</SelectContent>
    </Select>
  </label>;
}
