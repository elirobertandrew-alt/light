import { FormEvent, useState } from 'react';
import { createAuthClient } from '@neondatabase/neon-js/auth';

const authClient = createAuthClient(import.meta.env.VITE_NEON_AUTH_URL);
type Screen = 'join' | 'verify' | 'signin' | 'forgot' | 'reset';

function errorMessage(reason: unknown) {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'object' && reason && 'message' in reason) return String(reason.message);
  return 'Something went wrong.';
}

function signInErrorMessage(message: string | undefined) {
  if (message?.toLowerCase().includes('not verified')) {
    return 'Verify your email before signing in. Use the 6-digit code we sent, or send a new code.';
  }
  return message || 'Invalid email or password.';
}

export default function AuthGate({ onAuthenticated }: { onAuthenticated: (token: string) => void }) {
  const [screen, setScreen] = useState<Screen>('join');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function finish(result: unknown) {
    const response = result as { data?: { token?: string } | null; error?: { message?: string } | null };
    if (response.error) throw new Error(response.error.message || 'Something went wrong.');
    const token = response.data?.token;
    if (!token) throw new Error('Light could not start your session.');
    onAuthenticated(token);
  }

  async function act(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (screen === 'join') {
        const result = await authClient.signUp.email({ name, email, password });
        if (result.error) throw new Error(result.error.message);
        setMessage(`We emailed a randomized 6-digit code to ${email}.`);
        setScreen('verify');
      } else if (screen === 'verify') {
        finish(await authClient.emailOtp.verifyEmail({ email, otp: code }));
      } else if (screen === 'signin') {
        const result = await authClient.signIn.email({ email, password });
        if (result.error) throw new Error(signInErrorMessage(result.error.message));
        finish(result);
      } else if (screen === 'forgot') {
        const result = await authClient.forgetPassword.emailOtp({ email });
        if (result.error) throw new Error(result.error.message);
        setMessage('If that account exists, a randomized 6-digit reset code is on its way.');
        setScreen('reset');
      } else {
        const result = await authClient.emailOtp.resetPassword({ email, otp: code, password });
        if (result.error) throw new Error(result.error.message);
        const signIn = await authClient.signIn.email({ email, password });
        finish(signIn);
      }
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function resendVerificationCode() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await authClient.emailOtp.sendVerificationOtp({
        email,
        type: 'email-verification',
      });
      if (result.error) throw new Error(result.error.message);
      setCode('');
      setMessage(`We sent a new 6-digit code to ${email}.`);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  function switchTo(next: Screen) {
    setScreen(next);
    setError('');
    setMessage('');
    setCode('');
  }

  const titles: Record<Screen, string> = {
    join: 'Create your Light account',
    verify: 'Verify your email',
    signin: 'Welcome back',
    forgot: 'Reset your password',
    reset: 'Choose a new password',
  };

  const submitLabels: Record<Screen, string> = {
    join: 'Create account',
    verify: 'Verify and continue',
    signin: 'Sign in',
    forgot: 'Email reset code',
    reset: 'Reset password',
  };

  return <main className="auth-shell">
    <section className="auth-panel">
      <div className="auth-brand"><span className="brand-mark">L</span><span><b>Light</b><small>Model control, made simple</small></span></div>
      <div className="auth-copy"><p className="eyebrow">Your intelligent model layer</p><h1>One account.<br/>Every model.<br/><em>Always ready.</em></h1><p>Build your model catalog and fallback order now. Connect providers when you are ready.</p></div>
    </section>
    <section className="auth-card">
      <div className="auth-switch"><span>{screen === 'join' ? 'Already have an account?' : 'New to Light?'}</span><button className="secondary" type="button" onClick={() => switchTo(screen === 'join' ? 'signin' : 'join')}>{screen === 'join' ? 'Sign in' : 'Join'}</button></div>
      <div className="auth-form-wrap">
        <p className="eyebrow">Secure access</p><h2>{titles[screen]}</h2>
        {message && <p className="notice">{message}</p>}{error && <p className="notice error" role="alert">{error}</p>}
        <form className="auth-form" onSubmit={act}>
          {screen === 'join' && <label>Name<input value={name} onChange={event => setName(event.target.value)} autoComplete="name" minLength={2} required /></label>}
          <label>Email<input type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="email" required disabled={screen === 'verify' || screen === 'reset'} /></label>
          {(screen === 'join' || screen === 'signin' || screen === 'reset') && <label>{screen === 'reset' ? 'New password' : 'Password'}<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete={screen === 'signin' ? 'current-password' : 'new-password'} minLength={8} required /></label>}
          {(screen === 'verify' || screen === 'reset') && <label>6-digit code<input aria-label="6-digit code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ''))} required /></label>}
          <button disabled={busy}>{busy ? 'Please wait…' : submitLabels[screen]}</button>
        </form>
        {screen === 'signin' && <button className="auth-link" type="button" onClick={() => switchTo('forgot')}>Forgot password?</button>}
        {screen === 'verify' && <button className="auth-link" type="button" disabled={busy} onClick={resendVerificationCode}>Send a new code</button>}
        {(screen === 'verify' || screen === 'reset') && <button className="auth-link" type="button" onClick={() => switchTo(screen === 'verify' ? 'join' : 'forgot')}>Use another email</button>}
      </div>
    </section>
  </main>;
}
