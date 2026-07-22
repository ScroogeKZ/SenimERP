'use client';

import React, { useState, useEffect } from 'react';
import { 
  FileText, 
  Package, 
  ShieldCheck, 
  TrendingUp, 
  CreditCard, 
  UserCheck, 
  Activity, 
  CheckCircle, 
  AlertTriangle,
  ShoppingBag,
  BarChart3,
  Boxes
} from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid
} from 'recharts';
import { Header } from '../components/Header';
import { Sidebar, TabType } from '../components/Sidebar';

export default function ErpDashboard() {
  const [activeTab, setActiveTab] = useState<TabType>('invoices');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [ssoToken, setSsoToken] = useState<string>('');
  const [user, setUser] = useState<any>(null);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [waybills, setWaybills] = useState<any[]>([]);
  const [acts, setActs] = useState<any[]>([]);
  const [debtors, setDebtors] = useState<any[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<any[]>([]);

  // BI Reports state
  const [dashboardSummary, setDashboardSummary] = useState<any>(null);
  const [revenueTrend, setRevenueTrend] = useState<any[]>([]);
  const [topCustomers, setTopCustomers] = useState<any[]>([]);
  const [topProducts, setTopProducts] = useState<any[]>([]);
  const [arAging, setArAging] = useState<any>(null);
  const [apAging, setApAging] = useState<any>(null);
  const [stockHealth, setStockHealth] = useState<any[]>([]);
  
  // Modals / Details state
  const [selectedInvoice, setSelectedInvoice] = useState<any>(null);
  const [selectedWaybill, setSelectedWaybill] = useState<any>(null);
  const [selectedAct, setSelectedAct] = useState<any>(null);
  const [selectedPo, setSelectedPo] = useState<any>(null);
  const [payAmount, setPayAmount] = useState<string>('');
  
  // Status alerts
  const [alert, setAlert] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  // Safe JWT payload parser supporting base64url (-_) and UTF-8
  const parseJwtPayload = (token: string) => {
    try {
      const parts = token.split('.');
      if (parts.length < 2) return null;
      let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (base64.length % 4 !== 0) {
        base64 += '=';
      }
      const jsonPayload = decodeURIComponent(
        window
          .atob(base64)
          .split('')
          .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
          .join('')
      );
      return JSON.parse(jsonPayload);
    } catch (e) {
      console.error('Failed to parse JWT payload', e);
      return null;
    }
  };

  // Helper for quick local development login
  const handleDevLogin = () => {
    const mockHeader = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const mockPayload = btoa(JSON.stringify({
      sub: 'usr_accountant_test',
      email: 'accountant@senim.kz',
      tenantId: 'tenant_alpha',
      roles: ['ERP_ACCOUNTANT', 'CRM_MANAGER']
    }));
    const mockToken = `${mockHeader}.${mockPayload}.mock_signature`;
    localStorage.setItem('sso_token', mockToken);
    setSsoToken(mockToken);
    setUser({
      sub: 'usr_accountant_test',
      email: 'accountant@senim.kz',
      tenantId: 'tenant_alpha',
      roles: ['ERP_ACCOUNTANT', 'CRM_MANAGER']
    });
  };

  // Initialize SSO session
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('sso_token') || localStorage.getItem('sso_token');

    if (token) {
      const payload = parseJwtPayload(token);
      if (payload) {
        setSsoToken(token);
        localStorage.setItem('sso_token', token);
        setUser(payload);
        return;
      }
    }

    // Auto-redirect to SSO Auth Service
    const currentUrl = typeof window !== 'undefined' ? window.location.href.split('?')[0] : 'http://localhost:3005';
    window.location.href = `http://localhost:3001/login?redirect_uri=${encodeURIComponent(currentUrl)}`;
  }, []);

  // Fetch ERP resources
  const fetchData = async () => {
    if (!ssoToken || !user) return;

    const headers = {
      'Authorization': `Bearer ${ssoToken}`,
      'Content-Type': 'application/json'
    };

    try {
      const [
        invRes,
        wayRes,
        actRes,
        debtRes,
        supRes,
        poRes,
        dashRes,
        revRes,
        topCustRes,
        topProdRes,
        arAgingRes,
        apAgingRes,
        stockRes
      ] = await Promise.all([
        fetch('http://localhost:3004/api/invoices', { headers }),
        fetch('http://localhost:3004/api/waybills', { headers }),
        fetch('http://localhost:3004/api/acts', { headers }),
        fetch('http://localhost:3004/api/reports/debtors', { headers }),
        fetch('http://localhost:3004/api/suppliers', { headers }),
        fetch('http://localhost:3004/api/purchase-orders', { headers }),
        fetch('http://localhost:3004/api/reports/dashboard-summary', { headers }),
        fetch('http://localhost:3004/api/reports/revenue-trend', { headers }),
        fetch('http://localhost:3004/api/reports/top-customers', { headers }),
        fetch('http://localhost:3004/api/reports/top-products', { headers }),
        fetch('http://localhost:3004/api/reports/ar-aging', { headers }),
        fetch('http://localhost:3004/api/reports/ap-aging', { headers }),
        fetch('http://localhost:3004/api/reports/stock-health', { headers }),
      ]);

      if (invRes.ok) setInvoices(await invRes.json());
      if (wayRes.ok) setWaybills(await wayRes.json());
      if (actRes.ok) setActs(await actRes.json());
      if (debtRes.ok) setDebtors(await debtRes.json());
      if (supRes.ok) setSuppliers(await supRes.json());
      if (poRes.ok) setPurchaseOrders(await poRes.json());
      if (dashRes.ok) setDashboardSummary(await dashRes.json());
      if (revRes.ok) setRevenueTrend(await revRes.json());
      if (topCustRes.ok) setTopCustomers(await topCustRes.json());
      if (topProdRes.ok) setTopProducts(await topProdRes.json());
      if (arAgingRes.ok) setArAging(await arAgingRes.json());
      if (apAgingRes.ok) setApAging(await apAgingRes.json());
      if (stockRes.ok) setStockHealth(await stockRes.json());

    } catch (e) {
      console.error('API Error', e);
      triggerAlert('error', 'Ошибка подключения к серверу ERP');
    }
  };

  useEffect(() => {
    if (ssoToken && user) {
      fetchData();
    }
  }, [ssoToken, user]);

  const triggerAlert = (type: 'success' | 'error' | 'info', text: string) => {
    setAlert({ type, text });
    setTimeout(() => setAlert(null), 5000);
  };

  // --- NCALayer signing handler ---
  const signDocument = async (docType: 'invoice' | 'waybill' | 'act', id: string, number: string) => {
    triggerAlert('info', `Подключение к NCALayer на локальном ПК...`);

    const ws = new WebSocket('ws://127.0.0.1:13579');

    ws.onopen = () => {
      const request = {
        module: 'kz.gov.pki.knca.commonUtils',
        method: 'signXml',
        args: [
          'PKCS12',
          'SIGNATURE',
          `<document><id>${id}</id><number>${number}</number><timestamp>${new Date().toISOString()}</timestamp></document>`,
          '',
          ''
        ]
      };
      ws.send(JSON.stringify(request));
    };

    ws.onmessage = async (wsEvent) => {
      try {
        const response = JSON.parse(wsEvent.data);
        if (response.code === '200' && response.responseObject) {
          const signedXml = response.responseObject;
          
          const apiHeaders = {
            'Authorization': `Bearer ${ssoToken}`,
            'Content-Type': 'application/json'
          };
          
          const res = await fetch(`http://localhost:3004/api/${docType}s/${id}/sign`, {
            method: 'POST',
            headers: apiHeaders,
            body: JSON.stringify({ signedXml })
          });

          if (res.ok) {
            triggerAlert('success', `Документ ${number} успешно подписан ЭЦП и проведен!`);
            fetchData();
            setSelectedInvoice(null);
            setSelectedWaybill(null);
            setSelectedAct(null);
          } else {
            const errData = await res.json();
            triggerAlert('error', `Ошибка проведения подписи: ${errData.message}`);
          }
        } else {
          triggerAlert('error', `NCALayer отклонил подписание: ${response.message}`);
        }
      } catch (err) {
        triggerAlert('error', `Ошибка разбора ответа от NCALayer: ${(err as Error).message}`);
      } finally {
        ws.close();
      }
    };

    ws.onerror = () => {
      triggerAlert('error', 'Не удалось связаться с NCALayer. Запустите приложение NCALayer на вашем компьютере или убедитесь, что мок-сервер NCALayer активен на порту 13579.');
      ws.close();
    };
  };

  // --- Payment handler ---
  const handlePayment = async (invoiceId: string) => {
    if (!payAmount || isNaN(Number(payAmount)) || Number(payAmount) <= 0) {
      triggerAlert('error', 'Укажите корректную сумму для оплаты');
      return;
    }

    const headers = {
      'Authorization': `Bearer ${ssoToken}`,
      'Content-Type': 'application/json'
    };

    try {
      const res = await fetch(`http://localhost:3004/api/invoices/${invoiceId}/pay`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ amount: Number(payAmount) })
      });

      if (res.ok) {
        triggerAlert('success', `Оплата на сумму ${Number(payAmount).toLocaleString()} ₸ зарегистрирована.`);
        setPayAmount('');
        fetchData();
        setSelectedInvoice(null);
      } else {
        const err = await res.json();
        triggerAlert('error', `Ошибка оплаты: ${err.message}`);
      }
    } catch (e) {
      triggerAlert('error', `Сетевая ошибка при оплате: ${(e as Error).message}`);
    }
  };

  const getStatusBadgeClass = (status: string) => {
    switch (status) {
      case 'DRAFT':
        return 'bg-[var(--warning)]/10 text-[var(--warning)] border border-[var(--warning)]/20';
      case 'ISSUED':
        return 'bg-[var(--accent-soft)] text-[var(--accent)] border border-[var(--accent)]/20';
      case 'PARTIALLY_PAID':
        return 'bg-blue-500/10 text-blue-500 border border-blue-500/20';
      case 'PAID':
      case 'DELIVERED':
      case 'SIGNED_BY_CUSTOMER':
        return 'bg-[var(--success)]/10 text-[var(--success)] border border-[var(--success)]/20';
      case 'CANCELLED':
      case 'OVERDUE':
        return 'bg-[var(--danger)]/10 text-[var(--danger)] border border-[var(--danger)]/20';
      default:
        return 'bg-[var(--surface)] text-[var(--ink-muted)] border border-[var(--hairline)]';
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'DRAFT': return 'Черновик';
      case 'ISSUED': return 'Выставлен';
      case 'PARTIALLY_PAID': return 'Частично оплачен';
      case 'PAID': return 'Оплачен';
      case 'DELIVERED': return 'Доставлен';
      case 'SIGNED_BY_CUSTOMER': return 'Подписан клиентом';
      case 'CANCELLED': return 'Отменен';
      default: return status;
    }
  };

  const getEsfBadgeClass = (status?: string) => {
    switch (status) {
      case 'REGISTERED': return 'bg-[var(--success)]/10 text-[var(--success)] border border-[var(--success)]/20';
      case 'SUBMITTED': return 'bg-[var(--warning)]/10 text-[var(--warning)] border border-[var(--warning)]/20';
      case 'PENDING': return 'bg-blue-500/10 text-blue-500 border border-blue-500/20';
      case 'REJECTED': return 'bg-[var(--danger)]/10 text-[var(--danger)] border border-[var(--danger)]/20';
      case 'FAILED': return 'bg-[var(--danger)]/10 text-[var(--danger)] border border-[var(--danger)]/20';
      default: return 'bg-[var(--surface)] text-[var(--ink-muted)] border border-[var(--hairline)]';
    }
  };

  const getEsfLabel = (status?: string) => {
    switch (status) {
      case 'REGISTERED': return 'ЭСФ: Зарегистрирован';
      case 'SUBMITTED': return 'ЭСФ: Отправлен';
      case 'PENDING': return 'ЭСФ: В очереди';
      case 'REJECTED': return 'ЭСФ: Отклонен';
      case 'FAILED': return 'ЭСФ: Ошибка';
      default: return 'ЭСФ: Не выписан';
    }
  };

  const getTabLabel = (tab: TabType) => {
    switch (tab) {
      case 'invoices': return 'Счета на оплату';
      case 'waybills': return 'Накладные';
      case 'acts': return 'Акты (АВР)';
      case 'debtors': return 'Долги';
      case 'purchasing': return 'Закупки';
      case 'analytics': return 'Аналитика';
      default: return 'Бухгалтерия';
    }
  };

  const retryEsf = async (docType: 'invoice' | 'waybill' | 'act', id: string) => {
    try {
      const headers = {
        'Authorization': `Bearer ${ssoToken}`,
        'Content-Type': 'application/json'
      };
      const res = await fetch(`http://localhost:3004/api/${docType}s/${id}/esf/retry`, {
        method: 'POST',
        headers
      });
      if (res.ok) {
        triggerAlert('success', 'Повторная отправка ЭСФ поставлена в очередь!');
        fetchData();
      } else {
        const err = await res.json();
        triggerAlert('error', `Ошибка повтора ЭСФ: ${err.message}`);
      }
    } catch (e) {
      triggerAlert('error', `Ошибка сети при повторе ЭСФ: ${(e as Error).message}`);
    }
  };

  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen space-y-6 bg-[var(--paper)] text-[var(--ink)] p-4">
        <div className="w-10 h-10 border-3 border-[var(--accent)] border-t-transparent rounded-full animate-spin"></div>
        <div className="text-center space-y-1">
          <p className="text-sm font-semibold text-[var(--ink)]">Проверка единой сессии SSO...</p>
          <p className="text-xs text-[var(--ink-muted)]">Перенаправление на сервер авторизации (http://localhost:3001)</p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
          <a
            href={`http://localhost:3001/login?redirect_uri=${encodeURIComponent(typeof window !== 'undefined' ? window.location.href.split('?')[0] : 'http://localhost:3005')}`}
            className="apple-btn-secondary text-xs"
          >
            Войти через Senim SSO
          </a>
          <button
            onClick={handleDevLogin}
            className="apple-btn-primary text-xs"
          >
            Демо-вход (Бухгалтер)
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--paper)] text-[var(--foreground)]">
      {/* 260px Fixed Left Sidebar (Off-canvas on mobile) */}
      <Sidebar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      {/* 64px Fixed Top Header */}
      <Header
        activeTabLabel={getTabLabel(activeTab)}
        ssoToken={ssoToken}
        user={user}
        onMenuClick={() => setSidebarOpen(true)}
      />

      {/* Main Content Area */}
      <main className="md:pl-[260px] pt-16 min-h-screen px-4 py-6 md:pr-8 md:py-8 space-y-6">

        {/* Global Toast Alert */}
        {alert && (
          <div className={`p-4 rounded-[var(--radius-lg)] flex items-center space-x-3 text-xs transition-all duration-300 ${
            alert.type === 'success' ? 'bg-[var(--success)]/10 text-[var(--success)] border border-[var(--success)]/20' :
            alert.type === 'error' ? 'bg-[var(--danger)]/10 text-[var(--danger)] border border-[var(--danger)]/20' :
            'bg-[var(--accent-soft)] text-[var(--accent)] border border-[var(--accent)]/20'
          }`}>
            {alert.type === 'success' && <CheckCircle className="w-4 h-4 flex-shrink-0" />}
            {alert.type === 'error' && <AlertTriangle className="w-4 h-4 flex-shrink-0" />}
            {alert.type === 'info' && <Activity className="w-4 h-4 flex-shrink-0" />}
            <span>{alert.text}</span>
          </div>
        )}

        {/* Module Greeting */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-[var(--ink)]">Бухгалтерский контур</h1>
            <p className="text-[var(--ink-muted)] text-xs mt-1">Реестр документов и дебиторской задолженности. Подписание ЭСФ/АВР посредством ЭЦП.</p>
          </div>
          <button onClick={fetchData} className="apple-btn-secondary text-xs w-full md:w-auto">
            Обновить данные
          </button>
        </div>

        {/* Tab contents */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          
          {/* Document Lists (2 cols) */}
          <div className="lg:col-span-2 space-y-4">
            
            {/* --- Invoices Tab --- */}
            {activeTab === 'invoices' && (
              <div className="space-y-4">
                <h2 className="text-base font-bold text-[var(--ink)]">Счета на оплату (Invoices)</h2>
                {invoices.length === 0 ? (
                  <div className="apple-card p-8 text-center text-xs text-[var(--ink-muted)]">
                    Счетов не найдено. Закройте сделку в CRM для создания черновика.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {invoices.map(inv => (
                      <div 
                        key={inv.id} 
                        onClick={() => { setSelectedInvoice(inv); setSelectedWaybill(null); setSelectedAct(null); }}
                        className={`apple-card p-4 flex items-center justify-between cursor-pointer transition-all hover:border-[var(--accent)] ${
                          selectedInvoice?.id === inv.id ? 'ring-2 ring-[var(--accent)] border-transparent' : ''
                        }`}
                      >
                        <div className="space-y-1">
                          <p className="font-bold text-xs text-[var(--ink)]">{inv.number}</p>
                          <p className="text-xs text-[var(--ink-muted)]">{inv.customer.name}</p>
                        </div>
                        <div className="flex items-center space-x-2">
                          <div className="text-right">
                            <p className="font-bold text-xs text-[var(--ink)]">{Number(inv.amount).toLocaleString()} ₸</p>
                            <p className="text-[10px] text-[var(--ink-muted)]">Оплачено: {Number(inv.paidAmount).toLocaleString()} ₸</p>
                          </div>
                          {inv.esfDocument && (
                            <span className={`px-2 py-0.5 text-[10px] font-bold rounded-full ${getEsfBadgeClass(inv.esfDocument.status)}`}>
                              {getEsfLabel(inv.esfDocument.status)}
                            </span>
                          )}
                          <span className={`px-2 py-0.5 text-[10px] font-bold rounded-full ${getStatusBadgeClass(inv.status)}`}>
                            {getStatusLabel(inv.status)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* --- Waybills Tab --- */}
            {activeTab === 'waybills' && (
              <div className="space-y-4">
                <h2 className="text-base font-bold text-[var(--ink)]">Накладные на отпуск (Waybills)</h2>
                {waybills.length === 0 ? (
                  <div className="apple-card p-8 text-center text-xs text-[var(--ink-muted)]">
                    Накладных не найдено. Накладная создается автоматически при наличии товаров в выигранной сделке.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {waybills.map(wb => (
                      <div 
                        key={wb.id} 
                        onClick={() => { setSelectedWaybill(wb); setSelectedInvoice(null); setSelectedAct(null); }}
                        className={`apple-card p-4 flex items-center justify-between cursor-pointer transition-all hover:border-[var(--accent)] ${
                          selectedWaybill?.id === wb.id ? 'ring-2 ring-[var(--accent)] border-transparent' : ''
                        }`}
                      >
                        <div className="space-y-1">
                          <p className="font-bold text-xs text-[var(--ink)]">{wb.number}</p>
                          <p className="text-xs text-[var(--ink-muted)]">{wb.customer.name}</p>
                        </div>
                        <div className="flex items-center space-x-2">
                          <p className="font-bold text-xs text-[var(--ink)]">{Number(wb.amount).toLocaleString()} ₸</p>
                          {wb.esfDocument && (
                            <span className={`px-2 py-0.5 text-[10px] font-bold rounded-full ${getEsfBadgeClass(wb.esfDocument.status)}`}>
                              {getEsfLabel(wb.esfDocument.status)}
                            </span>
                          )}
                          <span className={`px-2 py-0.5 text-[10px] font-bold rounded-full ${getStatusBadgeClass(wb.status)}`}>
                            {wb.status === 'DRAFT' ? 'Черновик' : 'Проведена'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* --- Acts Tab --- */}
            {activeTab === 'acts' && (
              <div className="space-y-4">
                <h2 className="text-base font-bold text-[var(--ink)]">Акты выполненных работ (Service Acts)</h2>
                {acts.length === 0 ? (
                  <div className="apple-card p-8 text-center text-xs text-[var(--ink-muted)]">
                    Актов выполненных работ не найдено. Акт создается для сервисных услуг.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {acts.map(act => (
                      <div 
                        key={act.id} 
                        onClick={() => { setSelectedAct(act); setSelectedInvoice(null); setSelectedWaybill(null); }}
                        className={`apple-card p-4 flex items-center justify-between cursor-pointer transition-all hover:border-[var(--accent)] ${
                          selectedAct?.id === act.id ? 'ring-2 ring-[var(--accent)] border-transparent' : ''
                        }`}
                      >
                        <div className="space-y-1">
                          <p className="font-bold text-xs text-[var(--ink)]">{act.number}</p>
                          <p className="text-xs text-[var(--ink-muted)]">{act.customer.name}</p>
                        </div>
                        <div className="flex items-center space-x-2">
                          <p className="font-bold text-xs text-[var(--ink)]">{Number(act.amount).toLocaleString()} ₸</p>
                          {act.esfDocument && (
                            <span className={`px-2 py-0.5 text-[10px] font-bold rounded-full ${getEsfBadgeClass(act.esfDocument.status)}`}>
                              {getEsfLabel(act.esfDocument.status)}
                            </span>
                          )}
                          <span className={`px-2 py-0.5 text-[10px] font-bold rounded-full ${getStatusBadgeClass(act.status)}`}>
                            {act.status === 'DRAFT' ? 'Черновик' : 'Подписан'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* --- Debtors Tab --- */}
            {activeTab === 'debtors' && (
              <div className="apple-card p-6 space-y-4">
                <h2 className="text-base font-bold text-[var(--ink)]">Взаиморасчёты с контрагентами</h2>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-[var(--hairline)] text-[var(--ink-muted)] font-semibold uppercase text-[10px]">
                        <th className="pb-3">Контрагент</th>
                        <th className="pb-3 text-right">Выставлено</th>
                        <th className="pb-3 text-right">Оплачено</th>
                        <th className="pb-3 text-right">Задолженность</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--hairline)]">
                      {debtors.map(d => (
                        <tr key={d.customerId} className="hover:bg-[var(--paper)]">
                          <td className="py-3">
                            <p className="font-semibold text-[var(--ink)]">{d.customerName}</p>
                            <p className="text-[10px] text-[var(--ink-muted)]">БИН: {d.bin}</p>
                          </td>
                          <td className="py-3 text-right font-medium text-[var(--ink)]">{d.totalBilled.toLocaleString()} ₸</td>
                          <td className="py-3 text-right font-medium text-[var(--success)]">{d.totalPaid.toLocaleString()} ₸</td>
                          <td className={`py-3 text-right font-bold ${d.outstandingDebt > 0 ? 'text-[var(--danger)]' : 'text-[var(--success)]'}`}>
                            {d.outstandingDebt.toLocaleString()} ₸
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* --- Purchasing Tab --- */}
            {activeTab === 'purchasing' && (
              <div className="space-y-6">
                <div className="flex justify-between items-center">
                  <h2 className="text-base font-bold text-[var(--ink)]">Заказы поставщикам (Purchase Orders)</h2>
                </div>

                {purchaseOrders.length === 0 ? (
                  <div className="apple-card p-8 text-center text-xs text-[var(--ink-muted)]">
                    Заказов поставщикам не найдено.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {purchaseOrders.map(po => {
                      const totalOrdered = po.items ? po.items.reduce((acc: number, i: any) => acc + Number(i.quantity), 0) : 0;
                      const totalReceived = po.items ? po.items.reduce((acc: number, i: any) => acc + Number(i.receivedQty), 0) : 0;
                      const progressPct = totalOrdered > 0 ? Math.min(100, Math.round((totalReceived / totalOrdered) * 100)) : 0;

                      return (
                        <div 
                          key={po.id} 
                          onClick={() => { setSelectedPo(po); setSelectedInvoice(null); setSelectedWaybill(null); setSelectedAct(null); }}
                          className={`apple-card p-4 space-y-3 cursor-pointer transition-all hover:border-[var(--accent)] ${
                            selectedPo?.id === po.id ? 'ring-2 ring-[var(--accent)] border-transparent' : ''
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="font-bold text-xs text-[var(--ink)]">{po.number}</p>
                              <p className="text-xs text-[var(--ink-muted)]">Поставщик: {po.supplier?.name || 'Не указан'}</p>
                            </div>
                            <span className={`px-2 py-0.5 text-[10px] font-bold rounded-full ${
                              po.status === 'RECEIVED' ? 'bg-[var(--success)]/10 text-[var(--success)] border border-[var(--success)]/20' :
                              po.status === 'PARTIALLY_RECEIVED' ? 'bg-blue-500/10 text-blue-500 border border-blue-500/20' :
                              po.status === 'SENT' ? 'bg-[var(--accent-soft)] text-[var(--accent)] border border-[var(--accent)]/20' :
                              'bg-[var(--warning)]/10 text-[var(--warning)] border border-[var(--warning)]/20'
                            }`}>
                              {po.status === 'DRAFT' ? 'Черновик' :
                               po.status === 'SENT' ? 'Отправлен' :
                               po.status === 'PARTIALLY_RECEIVED' ? 'Частично получен' :
                               po.status === 'RECEIVED' ? 'Получен' : po.status}
                            </span>
                          </div>

                          <div className="space-y-1 text-xs">
                            <div className="flex justify-between text-[11px] text-[var(--ink-muted)]">
                              <span>Прогресс прихода: {totalReceived} / {totalOrdered} шт ({progressPct}%)</span>
                            </div>
                            <div className="w-full h-1.5 bg-[var(--paper)] rounded-full overflow-hidden border border-[var(--hairline)]">
                              <div className="h-full bg-[var(--accent)] transition-all" style={{ width: `${progressPct}%` }}></div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Suppliers directory summary */}
                <div className="apple-card p-6 space-y-4">
                  <h3 className="text-sm font-bold text-[var(--ink)]">Справочник поставщиков</h3>
                  <div className="divide-y divide-[var(--hairline)] text-xs">
                    {suppliers.length === 0 ? (
                      <p className="text-[var(--ink-muted)] text-center py-2">Поставщики не внесены.</p>
                    ) : (
                      suppliers.map(s => (
                        <div key={s.id} className="py-2.5 flex justify-between items-center">
                          <div>
                            <p className="font-bold text-[var(--ink)]">{s.name}</p>
                            <p className="text-[10px] text-[var(--ink-muted)]">БИН: {s.bin || 'Не указан'} | Тел: {s.phone || '-'}</p>
                          </div>
                          <span className="text-[10px] font-mono text-[var(--ink-muted)]">{s.email || ''}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* --- Analytics Tab --- */}
            {activeTab === 'analytics' && (
              <div className="space-y-6">
                {/* 1. KPI Cards */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="apple-card p-5 flex flex-col justify-between">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-[var(--ink-muted)]">Выручка за месяц</span>
                      <div className="p-2 bg-[var(--accent-soft)] text-[var(--accent)] rounded-lg">
                        <TrendingUp className="w-4 h-4" />
                      </div>
                    </div>
                    <div className="mt-3">
                      <p className="text-xl font-bold tracking-tight text-[var(--ink)]">
                        {dashboardSummary?.revenueThisMonth ? `${dashboardSummary.revenueThisMonth.toLocaleString('ru-RU')} ₸` : '0 ₸'}
                      </p>
                      <p className="text-[10px] text-[var(--ink-muted)] mt-1">Признанный доход</p>
                    </div>
                  </div>

                  <div className="apple-card p-5 flex flex-col justify-between">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-[var(--ink-muted)]">Дебиторка (AR)</span>
                      <div className="p-2 bg-[var(--danger)]/10 text-[var(--danger)] rounded-lg">
                        <CreditCard className="w-4 h-4" />
                      </div>
                    </div>
                    <div className="mt-3">
                      <p className={`text-xl font-bold tracking-tight ${
                        (dashboardSummary?.arOutstandingTotal || 0) > 0 ? 'text-[var(--danger)]' : 'text-[var(--ink)]'
                      }`}>
                        {dashboardSummary?.arOutstandingTotal ? `${dashboardSummary.arOutstandingTotal.toLocaleString('ru-RU')} ₸` : '0 ₸'}
                      </p>
                      <p className="text-[10px] text-[var(--ink-muted)] mt-1">Долг клиентов</p>
                    </div>
                  </div>

                  <div className="apple-card p-5 flex flex-col justify-between">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-[var(--ink-muted)]">Кредиторка (AP)</span>
                      <div className="p-2 bg-[var(--warning)]/10 text-[var(--warning)] rounded-lg">
                        <ShoppingBag className="w-4 h-4" />
                      </div>
                    </div>
                    <div className="mt-3">
                      <p className="text-xl font-bold tracking-tight text-[var(--ink)]">
                        {dashboardSummary?.apOutstandingTotal ? `${dashboardSummary.apOutstandingTotal.toLocaleString('ru-RU')} ₸` : '0 ₸'}
                      </p>
                      <p className="text-[10px] text-[var(--ink-muted)] mt-1">Долг поставщикам</p>
                    </div>
                  </div>

                  <div className="apple-card p-5 flex flex-col justify-between">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-[var(--ink-muted)]">Низкий остаток</span>
                      <div className="p-2 bg-[var(--accent-soft)] text-[var(--accent)] rounded-lg">
                        <Package className="w-4 h-4" />
                      </div>
                    </div>
                    <div className="mt-3">
                      <p className={`text-xl font-bold tracking-tight ${
                        (dashboardSummary?.lowStockItemCount || 0) > 0 ? 'text-[var(--warning)]' : 'text-[var(--ink)]'
                      }`}>
                        {dashboardSummary?.lowStockItemCount ?? 0} <span className="text-xs font-normal text-[var(--ink-muted)]">SKU</span>
                      </p>
                      <div className="flex items-center space-x-1.5 mt-1">
                        {dashboardSummary?.currencyExposureCurrencies?.map((cur: string) => (
                          <span key={cur} className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-[var(--accent-soft)] text-[var(--accent)]">
                            {cur}
                          </span>
                        ))}
                        {(!dashboardSummary?.currencyExposureCurrencies || dashboardSummary.currencyExposureCurrencies.length === 0) && (
                          <p className="text-[10px] text-[var(--ink-muted)]">Под резервом</p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* 2. Revenue Trend Chart */}
                <div className="apple-card p-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-bold text-[var(--ink)]">Динамика выручки</h3>
                      <p className="text-xs text-[var(--ink-muted)]">Объем продаж по периодам (KZT)</p>
                    </div>
                    <span className="px-2.5 py-1 text-[10px] font-semibold rounded-lg bg-[var(--paper)] text-[var(--ink-muted)] border border-[var(--hairline)]">
                      Группировка: по месяцам
                    </span>
                  </div>

                  {revenueTrend.length > 0 ? (
                    <div className="h-64 w-full pt-4">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={revenueTrend}>
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--hairline)" />
                          <XAxis dataKey="period" stroke="var(--ink-muted)" fontSize={11} tickLine={false} />
                          <YAxis stroke="var(--ink-muted)" fontSize={11} tickLine={false} tickFormatter={(val) => `${val / 1000}k`} />
                          <Tooltip 
                            contentStyle={{ backgroundColor: 'var(--surface)', borderColor: 'var(--hairline)', borderRadius: 'var(--radius-md)', color: 'var(--ink)' }}
                            formatter={(value: any) => [`${Number(value).toLocaleString('ru-RU')} ₸`, 'Выручка']}
                            labelFormatter={(label) => `Период: ${label}`}
                          />
                          <Bar dataKey="revenue" fill="var(--accent)" radius={[6, 6, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <div className="h-48 flex items-center justify-center text-[var(--ink-muted)] text-xs">
                      Нет данных о выручке за выбранный период
                    </div>
                  )}
                </div>

                {/* 3. Top Customers & Top Products */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Top Customers */}
                  <div className="apple-card p-6 space-y-4">
                    <h3 className="text-sm font-bold text-[var(--ink)] flex items-center space-x-2">
                      <UserCheck className="w-4 h-4 text-[var(--accent)]" />
                      <span>Топ-5 Клиентов по выручке</span>
                    </h3>
                    <div className="space-y-3">
                      {topCustomers.map((cust, idx) => (
                        <div key={cust.customerId || idx} className="p-3 bg-[var(--paper)] rounded-xl border border-[var(--hairline)] flex items-center justify-between">
                          <div className="flex items-center space-x-3">
                            <span className="w-5 h-5 rounded-full bg-[var(--accent-soft)] text-[var(--accent)] font-bold text-[10px] flex items-center justify-center">
                              {idx + 1}
                            </span>
                            <div>
                              <p className="text-xs font-semibold text-[var(--ink)]">{cust.customerName}</p>
                              <p className="text-[10px] text-[var(--ink-muted)]">БИН: {cust.bin || '—'} • {cust.invoiceCount} сч.</p>
                            </div>
                          </div>
                          <span className="text-xs font-bold text-[var(--ink)]">
                            {cust.totalRevenue?.toLocaleString('ru-RU')} ₸
                          </span>
                        </div>
                      ))}
                      {topCustomers.length === 0 && (
                        <p className="text-[var(--ink-muted)] text-xs py-4 text-center">Нет данных о клиентах</p>
                      )}
                    </div>
                  </div>

                  {/* Top Products */}
                  <div className="apple-card p-6 space-y-4">
                    <h3 className="text-sm font-bold text-[var(--ink)] flex items-center space-x-2">
                      <Package className="w-4 h-4 text-[var(--accent)]" />
                      <span>Топ-5 Товаров и услуг</span>
                    </h3>
                    <div className="space-y-3">
                      {topProducts.map((prod, idx) => (
                        <div key={prod.sku || idx} className="p-3 bg-[var(--paper)] rounded-xl border border-[var(--hairline)] flex items-center justify-between">
                          <div className="flex items-center space-x-3">
                            <span className="w-5 h-5 rounded-full bg-[var(--accent-soft)] text-[var(--accent)] font-bold text-[10px] flex items-center justify-center">
                              {idx + 1}
                            </span>
                            <div>
                              <p className="text-xs font-semibold text-[var(--ink)]">{prod.name}</p>
                              <p className="text-[10px] text-[var(--ink-muted)]">SKU: {prod.sku} • {prod.totalQuantity} ед.</p>
                            </div>
                          </div>
                          <span className="text-xs font-bold text-[var(--ink)]">
                            {prod.totalRevenue?.toLocaleString('ru-RU')} ₸
                          </span>
                        </div>
                      ))}
                      {topProducts.length === 0 && (
                        <p className="text-[var(--ink-muted)] text-xs py-4 text-center">Нет данных о товарах</p>
                      )}
                    </div>
                  </div>
                </div>

                {/* 4. AR / AP Aging Tables */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* AR Aging */}
                  <div className="apple-card p-6 space-y-4">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-bold text-[var(--ink)]">Старение дебиторки (AR Aging)</h3>
                      <span className="text-xs font-bold text-[var(--danger)]">
                        Итого: {arAging?.totalOutstanding?.toLocaleString('ru-RU') || 0} ₸
                      </span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs text-left">
                        <thead className="text-[10px] uppercase text-[var(--ink-muted)] border-b border-[var(--hairline)]">
                          <tr>
                            <th className="py-2 px-3">Интервал</th>
                            <th className="py-2 px-3">Сумма долга</th>
                            <th className="py-2 px-3 text-right">Счетов</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--hairline)]">
                          {arAging?.buckets?.map((b: any) => {
                            const isCurrent = b.bucket === 'current';
                            const isMild = b.bucket === '1-30';
                            const isSevere = b.bucket === '90+';

                            return (
                              <tr key={b.bucket} className="hover:bg-[var(--paper)]">
                                <td className="py-2.5 px-3 font-semibold">
                                  <span className={`px-2 py-0.5 rounded text-[10px] ${
                                    isCurrent ? 'bg-[var(--paper)] text-[var(--ink-muted)]' :
                                    isMild ? 'bg-[var(--warning)]/10 text-[var(--warning)]' :
                                    isSevere ? 'bg-[var(--danger)]/20 text-[var(--danger)] font-bold' :
                                    'bg-[var(--danger)]/10 text-[var(--danger)]'
                                  }`}>
                                    {b.bucket === 'current' ? 'Текущие (в сроках)' : `${b.bucket} дней`}
                                  </span>
                                </td>
                                <td className={`py-2.5 px-3 font-medium ${isSevere ? 'text-[var(--danger)] font-bold' : 'text-[var(--ink)]'}`}>
                                  {b.totalOutstanding?.toLocaleString('ru-RU')} ₸
                                </td>
                                <td className="py-2.5 px-3 text-right text-[var(--ink-muted)]">{b.invoiceCount}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* AP Aging */}
                  <div className="apple-card p-6 space-y-4">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-bold text-[var(--ink)]">Старение кредиторки (AP Aging)</h3>
                      <span className="text-xs font-bold text-[var(--accent)]">
                        Итого: {apAging?.totalOutstanding?.toLocaleString('ru-RU') || 0} ₸
                      </span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs text-left">
                        <thead className="text-[10px] uppercase text-[var(--ink-muted)] border-b border-[var(--hairline)]">
                          <tr>
                            <th className="py-2 px-3">Интервал</th>
                            <th className="py-2 px-3">Сумма долга</th>
                            <th className="py-2 px-3 text-right">Счетов</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--hairline)]">
                          {apAging?.buckets?.map((b: any) => {
                            const isCurrent = b.bucket === 'current';
                            const isMild = b.bucket === '1-30';
                            const isSevere = b.bucket === '90+';

                            return (
                              <tr key={b.bucket} className="hover:bg-[var(--paper)]">
                                <td className="py-2.5 px-3 font-semibold">
                                  <span className={`px-2 py-0.5 rounded text-[10px] ${
                                    isCurrent ? 'bg-[var(--paper)] text-[var(--ink-muted)]' :
                                    isMild ? 'bg-[var(--warning)]/10 text-[var(--warning)]' :
                                    isSevere ? 'bg-[var(--danger)]/20 text-[var(--danger)] font-bold' :
                                    'bg-[var(--warning)]/10 text-[var(--warning)]'
                                  }`}>
                                    {b.bucket === 'current' ? 'Текущие (в сроках)' : `${b.bucket} дней`}
                                  </span>
                                </td>
                                <td className="py-2.5 px-3 font-medium text-[var(--ink)]">
                                  {b.totalOutstanding?.toLocaleString('ru-RU')} ₸
                                </td>
                                <td className="py-2.5 px-3 text-right text-[var(--ink-muted)]">{b.invoiceCount}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>

                {/* 5. Stock Health */}
                <div className="apple-card p-6 space-y-4">
                  <h3 className="text-sm font-bold text-[var(--ink)] flex items-center space-x-2">
                    <Boxes className="w-4 h-4 text-[var(--success)]" />
                    <span>Складской аудит и критические остатки</span>
                  </h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs text-left">
                      <thead className="text-[10px] uppercase text-[var(--ink-muted)] border-b border-[var(--hairline)]">
                        <tr>
                          <th className="py-2.5 px-4">Склад</th>
                          <th className="py-2.5 px-4">Всего SKU</th>
                          <th className="py-2.5 px-4">Общий остаток</th>
                          <th className="py-2.5 px-4">В резерве</th>
                          <th className="py-2.5 px-4 text-right">Низкий остаток</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--hairline)]">
                        {stockHealth.map((wh) => (
                          <tr key={wh.warehouseId} className="hover:bg-[var(--paper)]">
                            <td className="py-3 px-4 font-semibold text-[var(--ink)]">{wh.warehouseName}</td>
                            <td className="py-3 px-4 text-[var(--ink-muted)]">{wh.totalSkuCount}</td>
                            <td className="py-3 px-4 font-medium text-[var(--ink)]">{wh.totalQuantity} ед.</td>
                            <td className="py-3 px-4 text-[var(--ink-muted)]">{wh.totalReserved} ед.</td>
                            <td className="py-3 px-4 text-right">
                              {wh.lowStockCount > 0 ? (
                                <span className="px-2.5 py-1 rounded-lg text-[10px] font-bold bg-[var(--danger)]/10 text-[var(--danger)] border border-[var(--danger)]/20">
                                  {wh.lowStockCount} SKU под риском
                                </span>
                              ) : (
                                <span className="px-2.5 py-1 rounded-lg text-[10px] font-medium bg-[var(--success)]/10 text-[var(--success)] border border-[var(--success)]/20">
                                  В норме
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

              </div>
            )}

          </div>

          {/* Document Inspection Side Panel (1 col) */}
          {activeTab !== 'analytics' && (
            <div className="space-y-4">
              <h2 className="text-base font-bold text-[var(--ink)]">Детали документа</h2>
              
              {/* Invoice Detail Inspector */}
              {selectedInvoice && (
                <div className="apple-card p-6 space-y-6 relative">
                  <div className="flex justify-between items-start">
                    <div>
                      <h3 className="text-sm font-bold text-[var(--ink)]">{selectedInvoice.number}</h3>
                      <p className="text-xs text-[var(--ink-muted)] mt-1">Организация: {selectedInvoice.customer.name}</p>
                    </div>
                    <span className={`px-2.5 py-1 text-[10px] font-bold rounded-full ${getStatusBadgeClass(selectedInvoice.status)}`}>
                      {getStatusLabel(selectedInvoice.status)}
                    </span>
                  </div>

                  <div className="space-y-3">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--ink-muted)]">Спецификация</p>
                    <div className="divide-y divide-[var(--hairline)] text-xs">
                      {selectedInvoice.items && selectedInvoice.items.map((item: any) => (
                        <div key={item.id} className="py-2 flex justify-between">
                          <div>
                            <p className="font-medium text-[var(--ink)]">{item.name}</p>
                            <p className="text-[10px] text-[var(--ink-muted)]">SKU: {item.sku}</p>
                          </div>
                          <div className="text-right">
                            <p className="text-[var(--ink)]">{Number(item.quantity)} шт × {Number(item.price).toLocaleString()} ₸</p>
                            <p className="text-[10px] text-[var(--ink-muted)]">НДС {Number(item.vatRate)}%: {Number(item.vatAmount).toLocaleString()} ₸</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="border-t border-[var(--hairline)] pt-4 space-y-2 text-xs">
                    <div className="flex justify-between">
                      <span className="text-[var(--ink-muted)]">Сумма НДС:</span>
                      <span className="font-semibold text-[var(--ink)]">{Number(selectedInvoice.vatAmount).toLocaleString()} ₸</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="font-bold text-[var(--ink)]">Итого с НДС:</span>
                      <span className="font-black text-[var(--ink)]">{Number(selectedInvoice.amount).toLocaleString()} ₸</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[var(--ink-muted)]">Уже оплачено:</span>
                      <span className="font-semibold text-[var(--success)]">{Number(selectedInvoice.paidAmount).toLocaleString()} ₸</span>
                    </div>
                  </div>

                  {/* Signing & Payments actions */}
                  <div className="pt-2">
                    {selectedInvoice.status === 'DRAFT' && (
                      <button 
                        onClick={() => signDocument('invoice', selectedInvoice.id, selectedInvoice.number)}
                        className="apple-btn-primary w-full text-xs py-2.5"
                      >
                        <ShieldCheck className="w-4 h-4" />
                        <span>Подписать ЭЦП и выставить</span>
                      </button>
                    )}

                    {(selectedInvoice.status === 'ISSUED' || selectedInvoice.status === 'PARTIALLY_PAID') && (
                      <div className="space-y-3">
                        <div className="flex space-x-2">
                          <input 
                            type="number"
                            value={payAmount}
                            onChange={(e) => setPayAmount(e.target.value)}
                            placeholder="Сумма оплаты (₸)"
                            className="apple-input flex-1 text-xs"
                          />
                          <button 
                            onClick={() => handlePayment(selectedInvoice.id)}
                            className="apple-btn-primary text-xs"
                          >
                            <CreditCard className="w-4 h-4" />
                            <span>Оплатить</span>
                          </button>
                        </div>
                        <p className="text-[10px] text-[var(--ink-muted)] text-center">Оплата публикует событие <code>invoice.paid</code> в CRM.</p>
                      </div>
                    )}

                    {selectedInvoice.status === 'PAID' && (
                      <div className="p-3 rounded-xl bg-[var(--success)]/10 border border-[var(--success)]/20 flex items-center space-x-2 text-xs text-[var(--success)]">
                        <CheckCircle className="w-4 h-4" />
                        <span>Счёт полностью оплачен. Данные синхронизированы с CRM.</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Waybill Detail Inspector */}
              {selectedWaybill && (
                <div className="apple-card p-6 space-y-6">
                  <div className="flex justify-between items-start">
                    <div>
                      <h3 className="text-sm font-bold text-[var(--ink)]">{selectedWaybill.number}</h3>
                      <p className="text-xs text-[var(--ink-muted)] mt-1">Клиент: {selectedWaybill.customer.name}</p>
                    </div>
                    <span className={`px-2.5 py-1 text-[10px] font-bold rounded-full ${getStatusBadgeClass(selectedWaybill.status)}`}>
                      {selectedWaybill.status === 'DRAFT' ? 'В пути' : 'Доставлен'}
                    </span>
                  </div>

                  <div className="space-y-3">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--ink-muted)]">Содержимое накладной</p>
                    <div className="divide-y divide-[var(--hairline)] text-xs">
                      {selectedWaybill.items && selectedWaybill.items.map((item: any) => (
                        <div key={item.id} className="py-2 flex justify-between">
                          <div>
                            <p className="font-medium text-[var(--ink)]">{item.name}</p>
                            <p className="text-[10px] text-[var(--ink-muted)]">SKU: {item.sku}</p>
                          </div>
                          <div className="text-right">
                            <p className="text-[var(--ink)]">{Number(item.quantity)} шт</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {selectedWaybill.esfDocument && (
                    <div className="p-3 rounded-xl bg-[var(--paper)] border border-[var(--hairline)] space-y-2 text-xs">
                      <div className="flex justify-between items-center">
                        <span className="font-bold text-[var(--ink)]">Статус ИС ЭСФ:</span>
                        <span className={`px-2 py-0.5 text-[10px] font-bold rounded-full ${getEsfBadgeClass(selectedWaybill.esfDocument.status)}`}>
                          {getEsfLabel(selectedWaybill.esfDocument.status)}
                        </span>
                      </div>
                      {selectedWaybill.esfDocument.esfRegNumber && (
                        <p className="text-[11px] text-[var(--success)] font-mono">
                          Рег. №: {selectedWaybill.esfDocument.esfRegNumber}
                        </p>
                      )}
                      {selectedWaybill.esfDocument.errorMessage && (
                        <p className="text-[11px] text-[var(--danger)]">
                          Ошибка: {selectedWaybill.esfDocument.errorMessage}
                        </p>
                      )}
                      {(selectedWaybill.esfDocument.status === 'FAILED' || selectedWaybill.esfDocument.status === 'REJECTED') && (
                        <button 
                          onClick={() => retryEsf('waybill', selectedWaybill.id)}
                          className="apple-btn-secondary w-full text-xs mt-1"
                        >
                          Повторить подачу ЭСФ
                        </button>
                      )}
                    </div>
                  )}

                  {selectedWaybill.status === 'DRAFT' && (
                    <button 
                      onClick={() => signDocument('waybill', selectedWaybill.id, selectedWaybill.number)}
                      className="apple-btn-primary w-full text-xs py-2.5"
                    >
                      <ShieldCheck className="w-4 h-4" />
                      <span>Подписать получение ЭЦП</span>
                    </button>
                  )}
                </div>
              )}

              {/* Service Act Detail Inspector */}
              {selectedAct && (
                <div className="apple-card p-6 space-y-6">
                  <div className="flex justify-between items-start">
                    <div>
                      <h3 className="text-sm font-bold text-[var(--ink)]">{selectedAct.number}</h3>
                      <p className="text-xs text-[var(--ink-muted)] mt-1">Контрагент: {selectedAct.customer.name}</p>
                    </div>
                    <span className={`px-2.5 py-1 text-[10px] font-bold rounded-full ${getStatusBadgeClass(selectedAct.status)}`}>
                      {selectedAct.status === 'DRAFT' ? 'Ждет подписи' : 'Подписан'}
                    </span>
                  </div>

                  <div className="space-y-3">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--ink-muted)]">Выполненные услуги</p>
                    <div className="divide-y divide-[var(--hairline)] text-xs">
                      {selectedAct.items && selectedAct.items.map((item: any) => (
                        <div key={item.id} className="py-2 flex justify-between">
                          <div>
                            <p className="font-medium text-[var(--ink)]">{item.name}</p>
                            <p className="text-[10px] text-[var(--ink-muted)]">SKU: {item.sku}</p>
                          </div>
                          <div className="text-right">
                            <p className="text-[var(--ink)]">{Number(item.quantity)} усл</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {selectedAct.esfDocument && (
                    <div className="p-3 rounded-xl bg-[var(--paper)] border border-[var(--hairline)] space-y-2 text-xs">
                      <div className="flex justify-between items-center">
                        <span className="font-bold text-[var(--ink)]">Статус ИС ЭСФ:</span>
                        <span className={`px-2 py-0.5 text-[10px] font-bold rounded-full ${getEsfBadgeClass(selectedAct.esfDocument.status)}`}>
                          {getEsfLabel(selectedAct.esfDocument.status)}
                        </span>
                      </div>
                      {selectedAct.esfDocument.esfRegNumber && (
                        <p className="text-[11px] text-[var(--success)] font-mono">
                          Рег. №: {selectedAct.esfDocument.esfRegNumber}
                        </p>
                      )}
                      {selectedAct.esfDocument.errorMessage && (
                        <p className="text-[11px] text-[var(--danger)]">
                          Ошибка: {selectedAct.esfDocument.errorMessage}
                        </p>
                      )}
                      {(selectedAct.esfDocument.status === 'FAILED' || selectedAct.esfDocument.status === 'REJECTED') && (
                        <button 
                          onClick={() => retryEsf('act', selectedAct.id)}
                          className="apple-btn-secondary w-full text-xs mt-1"
                        >
                          Повторить подачу ЭСФ
                        </button>
                      )}
                    </div>
                  )}

                  {selectedAct.status === 'DRAFT' && (
                    <button 
                      onClick={() => signDocument('act', selectedAct.id, selectedAct.number)}
                      className="apple-btn-primary w-full text-xs py-2.5"
                    >
                      <ShieldCheck className="w-4 h-4" />
                      <span>Подписать АВР ЭЦП</span>
                    </button>
                  )}
                </div>
              )}

              {/* Default Empty State */}
              {!selectedInvoice && !selectedWaybill && !selectedAct && (
                <div className="apple-card p-6 text-center text-[var(--ink-muted)] text-xs">
                  Выберите документ в списке для детального просмотра и совершения действий.
                </div>
              )}

            </div>
          )}

        </div>

      </main>

    </div>
  );
}
