'use client';

import React from 'react';
import {
  FileText,
  Package,
  ShieldCheck,
  TrendingUp,
  ShoppingBag,
  BarChart3
} from 'lucide-react';

export type TabType = 'invoices' | 'waybills' | 'acts' | 'debtors' | 'purchasing' | 'analytics';

interface SidebarProps {
  activeTab: TabType;
  setActiveTab: (tab: TabType) => void;
}

const navItems: { id: TabType; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'invoices', label: 'Счета на оплату', icon: FileText },
  { id: 'waybills', label: 'Накладные', icon: Package },
  { id: 'acts', label: 'Акты (АВР)', icon: ShieldCheck },
  { id: 'debtors', label: 'Долги', icon: TrendingUp },
  { id: 'purchasing', label: 'Закупки', icon: ShoppingBag },
  { id: 'analytics', label: 'Аналитика', icon: BarChart3 },
];

export function Sidebar({ activeTab, setActiveTab }: SidebarProps) {
  return (
    <aside className="fixed top-0 bottom-0 left-0 w-[260px] z-50 bg-[var(--surface)] border-r border-[var(--hairline)] flex flex-col">
      {/* Brand Header */}
      <div className="h-16 flex items-center px-6 border-b border-[var(--hairline)]">
        <span className="text-xl font-extrabold tracking-tight bg-gradient-to-r from-[var(--accent)] to-[var(--gold)] bg-clip-text text-transparent">
          SenimERP
        </span>
        <span className="ml-2 px-2 py-0.5 text-[10px] font-bold rounded bg-[var(--accent-soft)] text-[var(--accent)] uppercase">
          Enterprise
        </span>
      </div>

      {/* Nav List */}
      <div className="flex-1 py-6 px-3 space-y-6 overflow-y-auto">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--ink-muted)] px-3 mb-2">
            Бухгалтерия
          </div>
          <nav className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveTab(item.id)}
                  className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-lg text-xs transition-all ${
                    isActive
                      ? 'bg-[var(--accent-soft)] text-[var(--accent)] font-semibold shadow-xs'
                      : 'text-[var(--ink-muted)] hover:text-[var(--ink)] hover:bg-[var(--paper)] font-medium'
                  }`}
                >
                  <Icon className={`w-4 h-4 ${isActive ? 'text-[var(--accent)]' : 'text-[var(--ink-muted)]'}`} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>
      </div>

      {/* Footer info */}
      <div className="p-4 border-t border-[var(--hairline)] text-[10px] text-[var(--ink-muted)] text-center">
        SenimERP v1.0 • 94-В Compliance
      </div>
    </aside>
  );
}
