import { Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import { currentTheme, setTheme, type Theme } from '../lib/theme';

export function ThemeToggle() {
  const [theme, set] = useState<Theme>(() => (document.documentElement.dataset.theme as Theme) || currentTheme());
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      onClick={() => {
        setTheme(next);
        set(next);
      }}
    >
      {theme === 'dark' ? <Sun size={16} aria-hidden /> : <Moon size={16} aria-hidden />}
    </button>
  );
}
