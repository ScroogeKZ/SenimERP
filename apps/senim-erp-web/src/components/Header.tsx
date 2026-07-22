'use client';

import React, { useState, useRef, useEffect } from 'react';
import { ChevronRight, Menu, LogOut } from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';

interface HeaderProps {
  activeTabLabel: string;
  ssoToken?: string;
  user?: any;
  onMenuClick?: () => void;
  onNavigateHome?: () => void;
  onLogout?: () => void;
}

export function Header({ activeTabLabel, ssoToken, user, onMenuClick, onNavigateHome, onLogout }: HeaderProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isMenuOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isMenuOpen]);

  return (
    <header className="fixed top-0 left-0 right-0 h-16 z-40 bg-[var(--surface)] border-b border-[var(--hairline)] px-4 md:px-6 flex items-center justify-between">
      {/* Left section: Breadcrumb & Menu Button */}
      <div className="flex items-center space-x-2 text-xs font-medium md:pl-[260px]">
        {onMenuClick && (
          <button
            onClick={onMenuClick}
            className="md:hidden p-2 -ml-2 rounded-lg hover:bg-[var(--paper)]"
            aria-label="Открыть меню"
          >
            <Menu className="w-5 h-5 text-[var(--ink)]" />
          </button>
        )}
        <span className="hidden md:inline-flex items-center space-x-2 text-[var(--ink-muted)]">
          <button onClick={onNavigateHome} className="hover:underline hover:text-[var(--ink)] transition-colors">
            SenimERP
          </button>
          <ChevronRight className="w-3.5 h-3.5 text-[var(--ink-muted)]" />
          <button onClick={onNavigateHome} className="hover:underline hover:text-[var(--ink)] transition-colors">
            Бухгалтерия
          </button>
          <ChevronRight className="w-3.5 h-3.5 text-[var(--ink-muted)]" />
        </span>
        <span className="text-[var(--ink)] font-semibold">{activeTabLabel}</span>
      </div>

      {/* Right section: Theme Toggle, App Switcher Pill, User Avatar */}
      <div className="flex items-center space-x-3 md:space-x-4">
        {/* Theme Toggle */}
        <ThemeToggle />

        {/* CRM / ERP Pill Switcher */}
        <div className="hidden sm:flex items-center p-1 bg-[var(--paper)] rounded-lg border border-[var(--hairline)] text-xs">
          <a
            href={ssoToken ? `http://localhost:3000?sso_token=${ssoToken}` : 'http://localhost:3000'}
            className="px-3 py-1 font-medium text-[var(--ink-muted)] hover:text-[var(--ink)] transition-colors rounded-md"
            title="Перейти в SenimCRM"
          >
            CRM
          </a>
          <span className="px-3 py-1 font-semibold rounded-md bg-[var(--surface)] text-[var(--ink)] shadow-sm border border-[var(--hairline)]">
            ERP
          </span>
        </div>

        {/* User Info & Avatar */}
        {user && (
          <div ref={menuRef} className="relative flex items-center space-x-3 text-xs sm:border-l sm:border-[var(--hairline)] sm:pl-4">
            <div className="text-right hidden sm:block">
              <p className="font-semibold text-[var(--ink)]">{user.email}</p>
              <p className="text-[var(--ink-muted)] text-[10px]">Тенант: {user.tenantId}</p>
            </div>
            <button
              type="button"
              onClick={() => setIsMenuOpen((prev) => !prev)}
              className="w-8 h-8 rounded-full flex items-center justify-center font-bold text-white shadow-sm flex-shrink-0 focus:outline-none focus:ring-2 focus:ring-[var(--accent)] transition-opacity hover:opacity-90 cursor-pointer"
              style={{ backgroundColor: 'var(--accent)' }}
              title={`${user.email} (${user.tenantId})`}
              aria-expanded={isMenuOpen}
              aria-label="Меню аккаунта"
            >
              {user.email ? user.email.charAt(0).toUpperCase() : 'E'}
            </button>

            {/* Account Dropdown Menu */}
            {isMenuOpen && (
              <div className="absolute right-0 top-full mt-2 w-56 rounded-xl bg-[var(--surface)] border border-[var(--hairline)] shadow-lg py-2 z-50 animate-in fade-in slide-in-from-top-2 duration-150">
                <div className="px-4 py-2 border-b border-[var(--hairline)]">
                  <p className="font-semibold text-[var(--ink)] truncate">{user.email}</p>
                  <p className="text-[var(--ink-muted)] text-[10px] mt-0.5">Тенант: {user.tenantId}</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setIsMenuOpen(false);
                    onLogout?.();
                  }}
                  className="w-full text-left px-4 py-2 text-xs font-medium text-[var(--ink)] hover:bg-[var(--paper)] flex items-center space-x-2 transition-colors cursor-pointer"
                >
                  <LogOut className="w-4 h-4 text-[var(--ink-muted)]" />
                  <span>Выйти</span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
