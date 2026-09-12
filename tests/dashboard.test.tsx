// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../web/App.js';

const jsonResponse = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' },
}));

describe('Light dashboard API contract', () => {
  beforeEach(() => {
    sessionStorage.setItem('light.adminToken', 'admin-test-token');
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse([])));
  });

  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it('loads routing and API keys from the backend collection endpoints', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /routing/i }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/admin/routes', expect.any(Object)));

    fireEvent.click(screen.getByRole('button', { name: /api keys/i }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/admin/keys', expect.any(Object)));
  });

  it('creates metadata-only providers without a credential field', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /providers/i }));
    expect(await screen.findByRole('button', { name: /add provider/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/api key|credential|secret/i)).not.toBeInTheDocument();
  });

  it('offers disconnected model placeholders and fallback ordering controls', async () => {
    render(<App />);
    expect(await screen.findByRole('button', { name: /models/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /models/i }));
    expect(await screen.findByRole('button', { name: /add model/i })).toBeInTheDocument();
    expect(screen.getByText(/disconnected/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /routing/i }));
    expect(await screen.findByRole('button', { name: /add fallback/i })).toBeInTheDocument();
    expect(screen.getByText(/lower numbers run first/i)).toBeInTheDocument();
  });

  it.each([
    ['Logs', '/admin/logs', [{ createdAt: '2026-09-11T20:00:00.000Z', status: 503, model: 'writer', stream: 0 }], ['writer', '503']],
    ['Routing', '/admin/routes', [{ alias: 'writer', providerId: 'local-placeholder', priority: 1, enabled: true }], ['writer', /local-placeholder/]],
    ['API Keys', '/admin/keys', [{ name: 'client', createdAt: '2026-09-11T20:00:00.000Z', revoked: 0 }], ['client', 'Active']],
  ])('renders backend fields accurately on %s', async (tab, endpoint, rows, expected) => {
    vi.mocked(fetch).mockImplementation((url) => jsonResponse(url === endpoint ? rows : []));
    render(<App />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(5));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(tab, 'i') }));
    for (const value of expected) expect(await screen.findByText(value)).toBeInTheDocument();
  });
});
