import type { Config } from 'tailwindcss';

const v = (n: string) => `rgb(var(--${n}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: v('bg'),
        panel: v('panel'),
        raised: v('raised'),
        line: v('line'),
        fg: v('fg'),
        muted: v('muted'),
        faint: v('faint'),
        accent: v('accent'),
        'accent-fg': v('accent-fg'),
        ok: v('ok'),
        warn: v('warn'),
        bad: v('bad'),
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      keyframes: {
        slidein: { from: { opacity: '0', transform: 'translateY(-8px)' }, to: { opacity: '1', transform: 'none' } },
        pulse2: { '0%,100%': { opacity: '1' }, '50%': { opacity: '.4' } },
      },
      animation: { slidein: 'slidein .25s ease-out', pulse2: '1.6s ease-in-out infinite pulse2' },
    },
  },
  plugins: [],
} satisfies Config;
