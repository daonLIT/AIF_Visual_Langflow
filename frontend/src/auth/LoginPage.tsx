import { useState, type FormEvent } from 'react';
import { LanguageToggle } from '@aif/workbench';
import { useT } from '@aif/workbench/i18n';
import { useSession } from './session';

/** 로그인 화면. 주소(?projectId= 등)는 그대로 두므로 로그인하면 원래 보려던 곳이 열린다. */
export function LoginPage() {
  const t = useT();
  const login = useSession((state) => state.login);
  const expired = useSession((state) => state.expired);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const failure = await login(username.trim(), password);
    setBusy(false);
    if (failure) {
      setError(t('auth.error.failed', { message: failure }));
      setPassword('');
    }
  };

  return (
    <div className="login-page" data-testid="aif-login">
      <form className="login-card" onSubmit={(event) => void submit(event)}>
        <div className="login-head">
          <h1>{t('auth.title')}</h1>
          <LanguageToggle />
        </div>
        {expired ? <p className="login-note">{t('auth.expired')}</p> : null}
        <label>
          {t('auth.username')}
          <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoFocus name="username" />
        </label>
        <label>
          {t('auth.password')}
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            name="password"
          />
        </label>
        {error ? (
          <p className="login-error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className="is-primary" disabled={busy || !username.trim() || !password}>
          {busy ? t('auth.signingIn') : t('auth.submit')}
        </button>
      </form>
    </div>
  );
}
