import { useQueryClient } from '@tanstack/react-query';
import { Menu, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useMe } from '../lib/useMe';
import { ThemeToggle } from './ThemeToggle';
import { Logo } from './ui';

function AccountMenu() {
  const me = useMe();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  if (me.isLoading) return <span className="w-16" aria-hidden />;
  if (!me.data) return <Link to="/login" className="btn btn-sm">Sign in</Link>;
  const a = me.data.account;
  return (
    <div className="relative">
      <button type="button" className="btn btn-sm max-w-[12rem]" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)}>
        <span className="truncate">{a.displayName || a.email}</span>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-40 mt-2 w-56 rounded-xl border border-line bg-panel p-1.5 shadow-2xl" onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
          <p className="truncate px-2.5 py-1.5 text-xs text-faint">{a.email}</p>
          <Link role="menuitem" to="/account" className="block rounded-lg px-2.5 py-1.5 text-sm hover:bg-raised">Your endpoints</Link>
          <Link role="menuitem" to="/docs" className="block rounded-lg px-2.5 py-1.5 text-sm hover:bg-raised">Docs</Link>
          <button
            role="menuitem"
            type="button"
            className="block w-full rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-raised"
            onClick={async () => {
              try {
                await api('/auth/logout', { method: 'POST' });
              } catch {
                /* already signed out */
              }
              qc.setQueryData(['me'], null);
              setOpen(false);
              nav('/');
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

const nav = [
  { to: '/docs', label: 'Docs' },
  { to: '/#pricing', label: 'Pricing', hash: true },
];

export function SiteLayout() {
  const [menu, setMenu] = useState(false);
  const loc = useLocation();
  useEffect(() => {
    setMenu(false);
    if (loc.hash) document.getElementById(loc.hash.slice(1))?.scrollIntoView();
    else window.scrollTo(0, 0);
  }, [loc.pathname, loc.hash]);
  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-fg">Skip to content</a>
      <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
          <Link to="/" aria-label="nanana home"><Logo /></Link>
          <nav aria-label="Main" className="hidden items-center gap-5 text-sm sm:flex">
            {nav.map((n) => n.hash ? <Link key={n.to} to={n.to} className="text-muted hover:text-fg">{n.label}</Link> : <NavLink key={n.to} to={n.to} className={({ isActive }) => (isActive ? 'text-fg' : 'text-muted hover:text-fg')}>{n.label}</NavLink>)}
            <a href="https://github.com/erostalevi/nanana-releases" className="text-muted hover:text-fg" rel="noreferrer noopener">GitHub</a>
          </nav>
          <div className="ml-auto flex items-center gap-1.5">
            <ThemeToggle />
            <AccountMenu />
            <button type="button" className="btn btn-ghost btn-sm sm:hidden" aria-label="Toggle menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>{menu ? <X size={18} aria-hidden /> : <Menu size={18} aria-hidden />}</button>
          </div>
        </div>
        {menu && (
          <nav aria-label="Mobile" className="flex flex-col gap-1 border-t border-line px-4 py-3 text-sm sm:hidden">
            <Link className="py-1.5" to="/docs">Docs</Link>
            <Link className="py-1.5" to="/#pricing">Pricing</Link>
            <a className="py-1.5" href="https://github.com/erostalevi/nanana-releases" rel="noreferrer noopener">GitHub</a>
          </nav>
        )}
      </header>
      <main id="main" className="flex-1"><Outlet /></main>
      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-sm text-muted sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <Logo size="sm" />
            <p className="text-xs text-faint">Ephemeral by design. Operated by an individual in Chile.</p>
          </div>
          <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-2">
            <a href="https://github.com/erostalevi/nanana-releases" rel="noreferrer noopener" className="hover:text-fg">GitHub</a>
            <Link to="/docs" className="hover:text-fg">Docs</Link>
            <Link to="/terms" className="hover:text-fg">Terms</Link>
            <Link to="/privacy" className="hover:text-fg">Privacy</Link>
            <Link to="/abuse" className="hover:text-fg">Abuse</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
