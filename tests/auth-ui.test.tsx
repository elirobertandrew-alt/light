// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  signUp: vi.fn(),
  sendVerificationOtp: vi.fn(),
  verifyEmail: vi.fn(),
  signIn: vi.fn(),
  forgot: vi.fn(),
  reset: vi.fn(),
}));

vi.mock('@neondatabase/neon-js/auth', () => ({
  createAuthClient: () => ({
    signUp: { email: auth.signUp },
    signIn: { email: auth.signIn },
    emailOtp: {
      sendVerificationOtp: auth.sendVerificationOtp,
      verifyEmail: auth.verifyEmail,
      resetPassword: auth.reset,
    },
    forgetPassword: { emailOtp: auth.forgot },
  }),
}));

import AuthGate from '../web/AuthGate.js';

beforeEach(() => {
  auth.signUp.mockResolvedValue({ data: { user: { id: '1' } }, error: null });
  auth.sendVerificationOtp.mockResolvedValue({ data: { success: true }, error: null });
  auth.verifyEmail.mockResolvedValue({ data: { token: 'verified-session' }, error: null });
  auth.signIn.mockResolvedValue({ data: { token: 'signed-in-session' }, error: null });
  auth.forgot.mockResolvedValue({ data: { success: true }, error: null });
  auth.reset.mockResolvedValue({ data: { success: true }, error: null });
});
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); });

async function join() {
  fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: 'Elijah' } });
  fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: 'elijah@example.com' } });
  fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'a secure password' } });
  fireEvent.click(screen.getByRole('button', { name: /create account/i }));
  return screen.findByLabelText(/6-digit code/i);
}

describe('Light account access', () => {
  it('shows join fields and sign in on the right', () => {
    render(<AuthGate onAuthenticated={() => undefined} />);
    expect(screen.getByLabelText(/^name$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^email$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
  });

  it('submits join and moves to randomized six-digit email verification', async () => {
    render(<AuthGate onAuthenticated={() => undefined} />);
    expect(await join()).toHaveAttribute('inputmode', 'numeric');
    expect(auth.signUp).toHaveBeenCalledWith({ name: 'Elijah', email: 'elijah@example.com', password: 'a secure password' });
    expect(screen.getByText(/randomized 6-digit code/i)).toBeInTheDocument();
  });

  it('verifies the emailed code and returns the managed session token', async () => {
    const onAuthenticated = vi.fn();
    render(<AuthGate onAuthenticated={onAuthenticated} />);
    const input = await join();
    fireEvent.change(input, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /verify and continue/i }));
    await vi.waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith('verified-session'));
    expect(auth.verifyEmail).toHaveBeenCalledWith({ email: 'elijah@example.com', otp: '123456' });
  });

  it('resends a fresh verification code from the verification screen', async () => {
    render(<AuthGate onAuthenticated={() => undefined} />);
    await join();
    fireEvent.click(screen.getByRole('button', { name: /send a new code/i }));
    await vi.waitFor(() => expect(auth.sendVerificationOtp).toHaveBeenCalledWith({
      email: 'elijah@example.com',
      type: 'email-verification',
    }));
    expect(await screen.findByText(/new 6-digit code/i)).toBeInTheDocument();
  });

  it('sends a fresh code and opens verification when an existing account is unverified', async () => {
    auth.signIn.mockResolvedValueOnce({ data: null, error: { message: 'Email not verified' } });
    render(<AuthGate onAuthenticated={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: 'Elijah@Example.com' } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'a secure password' } });
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    expect(await screen.findByLabelText(/6-digit code/i)).toBeInTheDocument();
    expect(auth.sendVerificationOtp).toHaveBeenCalledWith({
      email: 'elijah@example.com',
      type: 'email-verification',
    });
    expect(screen.getByText(/sent a new 6-digit code/i)).toBeInTheDocument();
  });

  it('signs an existing verified account in with its email and password', async () => {
    const onAuthenticated = vi.fn();
    render(<AuthGate onAuthenticated={onAuthenticated} />);
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: 'Elijah@Example.com' } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'a secure password' } });
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    await vi.waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith('signed-in-session'));
    expect(auth.signIn).toHaveBeenCalledWith({
      email: 'elijah@example.com',
      password: 'a secure password',
    });
  });

  it('offers forgot password and resets with an emailed code', async () => {
    const onAuthenticated = vi.fn();
    render(<AuthGate onAuthenticated={onAuthenticated} />);
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    fireEvent.click(screen.getByRole('button', { name: /forgot password/i }));
    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: 'elijah@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /email reset code/i }));
    expect(await screen.findByLabelText(/6-digit code/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/new password/i), { target: { value: 'a newer secure password' } });
    fireEvent.change(screen.getByLabelText(/6-digit code/i), { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: /^reset password$/i }));
    await vi.waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith('signed-in-session'));
    expect(auth.forgot).toHaveBeenCalledWith({ email: 'elijah@example.com' });
    expect(auth.reset).toHaveBeenCalledWith({ email: 'elijah@example.com', otp: '654321', password: 'a newer secure password' });
  });
});
