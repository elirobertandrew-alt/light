import { useState } from 'react';
import App from './App';
import AuthGate from './AuthGate';

export default function Root() {
  const [token, setToken] = useState(() => localStorage.getItem('light.session') ?? '');
  if (!token) return <AuthGate onAuthenticated={(value) => { localStorage.setItem('light.session', value); setToken(value); }} />;
  return <App />;
}