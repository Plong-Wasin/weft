export const resources = {
  en: {
    "app.title": "Weft",
    "app.welcome": "Your workspace for getting work done.",
    "actions.hello": "Say hello",
  },
} as const;

export type Locale = keyof typeof resources;
export type MessageKey = keyof (typeof resources)["en"];

export function translate(key: MessageKey, locale: Locale = "en"): string {
  return resources[locale][key];
}
