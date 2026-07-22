'use client';

import React from 'react';
import { ChevronRight } from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';

interface HeaderProps {
  activeTabLabel: string;
  ssoToken?: string;
  user?: any;
}

export function Header({ activeTabLabel, ssoToken, user }: HeaderProps) {
  return (
    <header className="fixed top-0 left-0 right-0 h-16 z-40 bg-[var(--surface)] border-b border-[var(--hairline)] px-6 flex items-center justify-between">
      {/* Left section: Breadcrumb */}
      <div className="flex items-center space-x-2 text-xs font-medium pl-[260px]">
        <span className="text-[var(--ink-muted)]">SenimERP</span>
        <ChevronRight className="w-3.5 h-3.5 text-[var(--ink-muted)]" />
        <span className="text-[var(--ink-muted)]">Бухгалтерия</span>
        <ChevronRight className="w-3.5 h-3.5 text-[var(--ink-muted)]" />
        <span className="text-[var(--ink)] font-semibold">{activeTabLabel}</span>
      </div>

      {/* Right section: Theme Toggle, App Switcher Pill, User Avatar */}
      <div className="flex items-center space-x-4">
        {/* Theme Toggle */}
        <ThemeToggle />

        {/* CRM / ERP Pill Switcher */}
        <div className="flex items-center p-1 bg-[var(--paper)] rounded-lg border border-[var(--hairline)] text-xs">
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
          <div className="flex items-center space-x-3 text-xs border-l border-[var(--hairline)] pl-4">
            <div className="text-right hidden sm:block">
              <p className="font-semibold text-[var(--ink)]">{user.email}</p>
              <p className="text-[var(--ink-muted)] text-[10px]">Тенант: {user.tenantId}</p>
            </div>
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center font-bold text-white shadow-sm"
              style={{ backgroundColor: 'var(--accent)' }}
              title={`${user.email} (${user.tenantId})`}
            >
              {user.email ? user.email.charAt(0).toUpperCase() : 'E'}
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
