import { Route, Routes } from 'react-router-dom';
import { DashboardApp } from './dashboard/DashboardApp';
import { apexOrigin, currentMode } from './lib/host';
import { SiteLayout } from './components/SiteLayout';
import { Landing } from './pages/Landing';
import { Docs } from './pages/Docs';
import { Login, AuthVerify } from './pages/Login';
import { Device } from './pages/Device';
import { Account } from './pages/Account';
import { Terms, Privacy, Abuse } from './pages/Legal';
import { Admin } from './pages/Admin';
import { NotFound } from './pages/NotFound';

export function App() {
  const mode = currentMode();
  if (mode.mode === 'dashboard') return <DashboardApp slug={mode.slug} base={mode.base} apex={apexOrigin(mode.base)} />;
  return (
    <Routes>
      <Route element={<SiteLayout />}>
        <Route index element={<Landing />} />
        <Route path="docs" element={<Docs />} />
        <Route path="login" element={<Login />} />
        <Route path="auth/verify" element={<AuthVerify />} />
        <Route path="device" element={<Device />} />
        <Route path="account" element={<Account />} />
        <Route path="terms" element={<Terms />} />
        <Route path="privacy" element={<Privacy />} />
        <Route path="abuse" element={<Abuse />} />
        <Route path="admin" element={<Admin />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
