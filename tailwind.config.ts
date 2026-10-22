import type { Config } from 'tailwindcss';

/**
 * Premium dark "slate" design system for the agent console.
 * Colours are tuned for a high-contrast, low-glare telemetry UI that reads well
 * on a projector during a live hackathon demo.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        // Semantic palette mapped 1:1 onto the four pipeline outcomes.
        safe: {
          DEFAULT: '#10b981',
          soft: 'rgba(16,185,129,0.14)',
        },
        fraud: {
          DEFAULT: '#f43f5e',
          soft: 'rgba(244,63,94,0.14)',
        },
        guard: {
          DEFAULT: '#f59e0b',
          soft: 'rgba(245,158,11,0.14)',
        },
        esc: {
          DEFAULT: '#a855f7',
          soft: 'rgba(168,85,247,0.14)',
        },
        decider: {
          DEFAULT: '#38bdf8',
          soft: 'rgba(56,189,248,0.14)',
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
        mono: [
          'JetBrains Mono',
          'SFMono-Regular',
          'ui-monospace',
          'Menlo',
          'Monaco',
          'Consolas',
          'monospace',
        ],
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(56,189,248,0.25), 0 8px 40px -12px rgba(56,189,248,0.45)',
        'glow-safe': '0 0 0 1px rgba(16,185,129,0.30), 0 8px 40px -12px rgba(16,185,129,0.45)',
        'glow-fraud': '0 0 0 1px rgba(244,63,94,0.35), 0 8px 40px -12px rgba(244,63,94,0.50)',
        panel: '0 20px 60px -30px rgba(0,0,0,0.9)',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'slide-in': {
          '0%': { opacity: '0', transform: 'translateX(16px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        'pulse-ring': {
          '0%': { transform: 'scale(0.85)', opacity: '0.7' },
          '70%': { transform: 'scale(1.6)', opacity: '0' },
          '100%': { transform: 'scale(1.6)', opacity: '0' },
        },
        'scan-line': {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(1000%)' },
        },
        'flash-red': {
          '0%, 100%': { backgroundColor: 'rgba(244,63,94,0.0)' },
          '35%': { backgroundColor: 'rgba(244,63,94,0.22)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-500px 0' },
          '100%': { backgroundPosition: '500px 0' },
        },
      },
      animation: {
        'fade-up': 'fade-up 320ms cubic-bezier(0.22,1,0.36,1) both',
        'fade-in': 'fade-in 240ms ease-out both',
        'slide-in': 'slide-in 300ms cubic-bezier(0.22,1,0.36,1) both',
        'pulse-ring': 'pulse-ring 1.8s cubic-bezier(0.24,0,0.38,1) infinite',
        'scan-line': 'scan-line 2.4s linear infinite',
        'flash-red': 'flash-red 900ms ease-out 1',
        shimmer: 'shimmer 1.6s linear infinite',
      },
    },
  },
  plugins: [],
};

export default config;
