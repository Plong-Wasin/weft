import React from "react";
import { translate } from "@weft/shared";
import { themes, useTheme } from "../theme";

export function ThemeSwitch() {
  const [theme, setTheme] = useTheme();
  return <label className="flex items-center gap-1.5">{translate("theme.label")}
    <select value={theme} onChange={(event) => setTheme(event.target.value as (typeof themes)[number])}>
      {themes.map((value) => <option key={value} value={value}>{translate(`theme.${value}`)}</option>)}
    </select></label>;
}
