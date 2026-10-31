import type { App } from './app-state';
import { Icon } from './ui/icons';
import { LocaleSwitch } from './shell';
import { t, useLocale } from './i18n';
import { enumLabel } from './i18n';

export function SignInScreen({ app }: { app: App }) {
  useLocale();
  return <main className="auth-screen">
    <div className="auth-corner"><LocaleSwitch /></div>
    <form className="auth-card" onSubmit={app.signIn}>
      <span className="brand-mark large" aria-hidden="true"><Icon name="timeline" /></span>
      <h1>{t('auth.title')}</h1>
      <p className="muted">{t('auth.intro')}</p>
      <label className="field">{t('auth.email')}<input type="email" autoComplete="username" value={app.email} onChange={(event) => app.setEmail(event.target.value)} required /></label>
      <label className="field">{t('auth.password')}<input type="password" autoComplete="current-password" value={app.password} onChange={(event) => app.setPassword(event.target.value)} required /></label>
      <button>{t('auth.signIn')}</button>
      {app.error && <p role="alert" className="notice">{app.error}</p>}
    </form>
  </main>;
}

export function WorkspacePicker({ app }: { app: App }) {
  useLocale();
  return <main className="auth-screen workspace-picker">
    <div className="auth-corner"><LocaleSwitch /></div>
    <div className="auth-card">
      <span className="brand-mark large" aria-hidden="true"><Icon name="timeline" /></span>
      <h1>{t('auth.chooseWorkspace')}</h1>
      <p className="muted">{t('auth.chooseHint')}</p>
      <ul>{app.workspaceChoices.map((item) => <li key={item.id}><button type="button" className="secondary" onClick={() => void app.chooseWorkspace(item)}>{item.name}<span className="muted">{enumLabel('role', item.role)}</span></button></li>)}</ul>
      <button type="button" className="ghost" onClick={() => void app.signOut()}>{t('menu.signOut')}</button>
    </div>
  </main>;
}
