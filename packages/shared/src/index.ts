export const resources = {
  en: {
    "app.title": "Weft",
    "app.welcome": "Your workspace for getting work done.",
    "actions.hello": "Say hello",
    "auth.signIn": "Sign in",
    "auth.signUp": "Create account",
    "auth.signOut": "Sign out",
    "auth.email": "Email",
    "auth.password": "Password",
    "auth.name": "Name",
    "auth.haveAccount": "Already have an account? Sign in",
    "auth.needAccount": "New to Weft? Create an account",
    "auth.failed": "Authentication failed. Check your details and try again.",
    "workspace.firstTitle": "Create your first workspace",
    "workspace.name": "Workspace name",
    "workspace.slug": "Workspace URL",
    "workspace.create": "Create workspace",
    "workspace.createFailed": "Could not create the workspace. Try another URL.",
    "workspace.yourWorkspaces": "Your workspaces",
    "workspace.noAccess": "You do not have a workspace yet. Ask an admin for an invite.",
  },
} as const;

export type Locale = keyof typeof resources;
export type MessageKey = keyof (typeof resources)["en"];

export function translate(key: MessageKey, locale: Locale = "en"): string {
  return resources[locale][key];
}
