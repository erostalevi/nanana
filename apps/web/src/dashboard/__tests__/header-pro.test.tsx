import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Subdomain } from '../../lib/types';
import { ExpiryBadge } from '../Header';

const sub = (over: Partial<Subdomain> = {}): Subdomain => ({
  slug: 'abc12345', url: 'https://abc12345.nanana.lat', dashboardUrl: '', isCustom: false, ownerId: 'a', state: 'active',
  lastActivityAt: new Date().toISOString(), hardExpiresAt: new Date(Date.now() + 6 * 864e5).toISOString(), offlineStatus: 200, offlineBody: '', hmac: null, tunnelOnline: false, mock: null, ...over,
});

describe('ExpiryBadge', () => {
  it('shows the countdown for free endpoints', () => {
    render(<ExpiryBadge sub={sub()} />);
    expect(screen.getByText(/gone in/)).toBeInTheDocument();
    expect(screen.queryByText('always-on')).toBeNull();
  });
  it('hides the countdown and shows Pro / always-on badges for always-on endpoints', () => {
    render(<ExpiryBadge sub={sub({ alwaysOn: true, reserved: true })} />);
    expect(screen.queryByText(/gone in/)).toBeNull();
    expect(screen.queryByText(/sleeps in/)).toBeNull();
    expect(screen.getByText('Pro')).toBeInTheDocument();
    expect(screen.getByText('always-on')).toBeInTheDocument();
    expect(screen.getByText('reserved')).toBeInTheDocument();
  });
  it('flags read-only endpoints', () => {
    render(<ExpiryBadge sub={sub({ alwaysOn: true, readOnly: true })} />);
    expect(screen.getByText('read-only')).toBeInTheDocument();
  });
});
