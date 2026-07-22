'use client';

import React from 'react';
import { Sun, Moon } from 'lucide-react';
import { useTheme } from '../lib/theme-context';

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();

  return (
    <button
      onClick={toggleTheme}
      type="button"
      className="p-2 rounded-lg border border-[var(--hairline)] bg-[var(--surface)] text-[var(--ink-muted)] hover:text-[var(--ink)] hover:bg-[var(--paper)] transition-all shadow-sm flex items-center justify-center"
      title={`Переключить тему на ${theme === 'light' ? 'Тёмную' : 'Светлую'}`}
      aria-label="Переключить тему"
    >
      {theme === 'light' ? (
        <Moon className="w-4 h-4 text-slate-600 dark:text-slate-300" />
      ) : (
        <Sun className="w-4 h-4 text-amber-400" />
      )}
    </button>
  );
}
