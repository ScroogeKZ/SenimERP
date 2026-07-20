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
  ChevronRight, 
  CheckCircle, 
  AlertTriangle,
  ShoppingBag
} from 'lucide-react';

export default function ErpDashboard() {
  const [activeTab, setActiveTab] = useState<'invoices' | 'waybills' | 'acts' | 'debtors' | 'purchasing'>('invoices');
  const [ssoToken, setSsoToken] = useState<string>('');
  const [user, setUser] = useState<any>(null);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [waybills, setWaybills] = useState<any[]>([]);
  const [acts, setActs] = useState<any[]>([]);
  const [debtors, setDebtors] = useState<any[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<any[]>([]);
  
  // Modals / Details state
  const [selectedInvoice, setSelectedInvoice] = useState<any>(null);
  const [selectedWaybill, setSelectedWaybill] = useState<any>(null);
  const [selectedAct, setSelectedAct] = useState<any>(null);
  const [selectedPo, setSelectedPo] = useState<any>(null);
  const [payAmount, setPayAmount] = useState<string>('');
  
  // Status alerts
  const [alert, setAlert] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  // Initialize SSO session
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('sso_token') || localStorage.getItem('sso_token');

    if (!token) {
      const redirectUrl = window.location.href.split('?')[0];
      window.location.href = `http://localhost:3001/login?redirect_uri=${encodeURIComponent(redirectUrl)}`;
      return;
    }

    setSsoToken(token);
    localStorage.setItem('sso_token', token);

    // Decode token
    try {
      const payloadBase64 = token.split('.')[1];
      const payloadJson = JSON.parse(atob(payloadBase64));
      setUser(payloadJson);
    } catch (e) {
      console.error('Failed to decode token', e);
      localStorage.removeItem('sso_token');
      window.location.href = `http://localhost:3001/login?redirect_uri=${encodeURIComponent(window.location.href.split('?')[0])}`;
    }
  }, []);

  // Fetch ERP resources
  const fetchData = async () => {
    if (!ssoToken || !user) return;

    const headers = {
      'Authorization': `Bearer ${ssoToken}`,
      'Content-Type': 'application/json'
    };

    try {
      const invRes = await fetch('http://localhost:3004/api/invoices', { headers });
      if (invRes.ok) setInvoices(await invRes.ok ? await invRes.json() : []);

      const wayRes = await fetch('http://localhost:3004/api/waybills', { headers });
      if (wayRes.ok) setWaybills(await wayRes.json());

      const actRes = await fetch('http://localhost:3004/api/acts', { headers });
      if (actRes.ok) setActs(await actRes.json());

      const debtRes = await fetch('http://localhost:3004/api/debtors', { headers });
      if (debtRes.ok) setDebtors(await debtRes.json());

      const supRes = await fetch('http://localhost:3004/api/suppliers', { headers });
      if (supRes.ok) setSuppliers(await supRes.json());

      const poRes = await fetch('http://localhost:3004/api/purchase-orders', { headers });
      if (poRes.ok) setPurchaseOrders(await poRes.json());
    } catch (e) {
      console.error('Failed to fetch ERP data', e);
      triggerAlert('error', 'Ошибка подключения к ERP API. Убедитесь, что сервер API запущен.');
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
      // Send sign request following the NCALayer standard protocol API
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
          
          // Submit signature to ERP API backend
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
            // Close details panels
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
        return 'bg-amber-500/10 text-amber-400 border border-amber-500/20';
      case 'ISSUED':
        return 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20';
      case 'PARTIALLY_PAID':
        return 'bg-blue-500/10 text-blue-400 border border-blue-500/20';
      case 'PAID':
      case 'DELIVERED':
      case 'SIGNED_BY_CUSTOMER':
        return 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
      case 'CANCELLED':
      case 'OVERDUE':
        return 'bg-rose-500/10 text-rose-400 border border-rose-500/20';
      default:
        return 'bg-slate-800 text-slate-400';
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
      case 'REGISTERED': return 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
      case 'SUBMITTED': return 'bg-amber-500/20 text-amber-300 border border-amber-500/30';
      case 'PENDING': return 'bg-blue-500/20 text-blue-300 border border-blue-500/30';
      case 'REJECTED': return 'bg-rose-500/20 text-rose-300 border border-rose-500/30';
      case 'FAILED': return 'bg-red-500/20 text-red-300 border border-red-500/30';
      default: return 'bg-slate-800 text-slate-400';
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
      <div className="flex flex-col items-center justify-center min-h-screen space-y-4">
        <div className="w-12 h-12 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
        <p className="text-sm font-semibold text-slate-400">Проверка единой сессии SSO...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      
      {/* Top Header */}
      <header className="glass sticky top-0 z-50 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center space-x-8">
          <div className="text-2xl font-extrabold tracking-tight bg-gradient-to-r from-indigo-400 to-purple-500 bg-clip-text text-transparent">
            SenimERP
          </div>
          <div className="px-2.5 py-1 text-[10px] font-bold uppercase rounded bg-indigo-500/20 text-indigo-300">
            Раздел: Бухгалтерия
          </div>
        </div>

        <div className="flex items-center space-x-6">
          <a href={`http://localhost:3000?sso_token=${ssoToken}`} className="text-xs font-bold uppercase tracking-wider px-3 py-1.5 rounded-md border border-slate-700 hover:border-slate-500 bg-slate-900 text-slate-300 transition-all hover:bg-slate-800">
            Вернуться в CRM ➔
          </a>

          <div className="flex items-center space-x-3 text-xs">
            <div className="text-right">
              <p className="font-semibold text-slate-200">{user.email}</p>
              <p className="text-slate-400 text-[10px]">Тенант ID: {user.tenantId}</p>
            </div>
            <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-purple-500 to-indigo-500 flex items-center justify-center font-bold text-slate-100">
              E
            </div>
          </div>
        </div>
      </header>

      {/* Main Layout container */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-6 md:p-8 space-y-6">

        {/* Global Toast Alert */}
        {alert && (
          <div className={`p-4 rounded-xl flex items-center space-x-3 text-sm transition-all duration-300 ${
            alert.type === 'success' ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30' :
            alert.type === 'error' ? 'bg-rose-500/10 text-rose-300 border border-rose-500/30' :
            'bg-blue-500/10 text-blue-300 border border-blue-500/30'
          }`}>
            {alert.type === 'success' && <CheckCircle className="w-5 h-5 flex-shrink-0" />}
            {alert.type === 'error' && <AlertTriangle className="w-5 h-5 flex-shrink-0" />}
            {alert.type === 'info' && <Activity className="w-5 h-5 flex-shrink-0" />}
            <span>{alert.text}</span>
          </div>
        )}

        {/* Module Greeting */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight">Бухгалтерский контур</h1>
            <p className="text-slate-400 mt-1">Реестр документов и дебиторской задолженности. Подписание ЭСФ/АВР посредством ЭЦП.</p>
          </div>
          <button onClick={fetchData} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-bold rounded-xl transition-all">
            Обновить данные
          </button>
        </div>

        {/* Navigation Tabs */}
        <div className="flex space-x-1 p-1 bg-slate-900 border border-slate-800 rounded-xl max-w-lg">
          <button 
            onClick={() => setActiveTab('invoices')}
            className={`flex-1 py-2 px-3 text-xs font-semibold rounded-lg transition-all flex items-center justify-center space-x-2 ${
              activeTab === 'invoices' ? 'bg-indigo-600 text-slate-100' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <FileText className="w-4 h-4" />
            <span>Счета на оплату</span>
          </button>
          <button 
            onClick={() => setActiveTab('waybills')}
            className={`flex-1 py-2 px-3 text-xs font-semibold rounded-lg transition-all flex items-center justify-center space-x-2 ${
              activeTab === 'waybills' ? 'bg-indigo-600 text-slate-100' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Package className="w-4 h-4" />
            <span>Накладные</span>
          </button>
          <button 
            onClick={() => setActiveTab('acts')}
            className={`flex-1 py-2 px-3 text-xs font-semibold rounded-lg transition-all flex items-center justify-center space-x-2 ${
              activeTab === 'acts' ? 'bg-indigo-600 text-slate-100' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <ShieldCheck className="w-4 h-4" />
            <span>Акты (АВР)</span>
          </button>
          <button 
            onClick={() => setActiveTab('debtors')}
            className={`flex-1 py-2 px-3 text-xs font-semibold rounded-lg transition-all flex items-center justify-center space-x-2 ${
              activeTab === 'debtors' ? 'bg-indigo-600 text-slate-100' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <TrendingUp className="w-4 h-4" />
            <span>Долги</span>
          </button>
          <button 
            onClick={() => setActiveTab('purchasing')}
            className={`flex-1 py-2 px-3 text-xs font-semibold rounded-lg transition-all flex items-center justify-center space-x-2 ${
              activeTab === 'purchasing' ? 'bg-indigo-600 text-slate-100' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <ShoppingBag className="w-4 h-4" />
            <span>Закупки</span>
          </button>
        </div>

        {/* Tab contents */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          
          {/* Document Lists (2 cols) */}
          <div className="lg:col-span-2 space-y-4">
            
            {/* --- Invoices Tab --- */}
            {activeTab === 'invoices' && (
              <div className="space-y-4">
                <h2 className="text-xl font-bold">Счета на оплату (Invoices)</h2>
                {invoices.length === 0 ? (
                  <p className="text-slate-500 text-sm glass p-6 rounded-2xl text-center">Счетов не найдено. Закройте сделку в CRM для создания черновика.</p>
                ) : (
                  <div className="space-y-3">
                    {invoices.map(inv => (
                      <div 
                        key={inv.id} 
                        onClick={() => { setSelectedInvoice(inv); setSelectedWaybill(null); setSelectedAct(null); }}
                        className={`glass p-4 rounded-xl flex items-center justify-between cursor-pointer transition-all hover:border-slate-600 ${
                          selectedInvoice?.id === inv.id ? 'ring-2 ring-indigo-500 border-transparent' : ''
                        }`}
                      >
                        <div className="space-y-1">
                          <p className="font-bold text-slate-100">{inv.number}</p>
                          <p className="text-xs text-slate-400">{inv.customer.name}</p>
                        </div>
                        <div className="flex items-center space-x-2">
                          <div className="text-right">
                            <p className="font-bold text-slate-100">{Number(inv.amount).toLocaleString()} ₸</p>
                            <p className="text-[10px] text-slate-400">Оплачено: {Number(inv.paidAmount).toLocaleString()} ₸</p>
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
                <h2 className="text-xl font-bold">Накладные на отпуск (Waybills)</h2>
                {waybills.length === 0 ? (
                  <p className="text-slate-500 text-sm glass p-6 rounded-2xl text-center">Накладных не найдено. Накладная создается автоматически при наличии товаров в выигранной сделке.</p>
                ) : (
                  <div className="space-y-3">
                    {waybills.map(wb => (
                      <div 
                        key={wb.id} 
                        onClick={() => { setSelectedWaybill(wb); setSelectedInvoice(null); setSelectedAct(null); }}
                        className={`glass p-4 rounded-xl flex items-center justify-between cursor-pointer transition-all hover:border-slate-600 ${
                          selectedWaybill?.id === wb.id ? 'ring-2 ring-indigo-500 border-transparent' : ''
                        }`}
                      >
                        <div className="space-y-1">
                          <p className="font-bold text-slate-100">{wb.number}</p>
                          <p className="text-xs text-slate-400">{wb.customer.name}</p>
                        </div>
                        <div className="flex items-center space-x-2">
                          <p className="font-bold text-slate-100">{Number(wb.amount).toLocaleString()} ₸</p>
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
                <h2 className="text-xl font-bold">Акты выполненных работ (Service Acts)</h2>
                {acts.length === 0 ? (
                  <p className="text-slate-500 text-sm glass p-6 rounded-2xl text-center">Актов выполненных работ не найдено. Акт создается для сервисных услуг.</p>
                ) : (
                  <div className="space-y-3">
                    {acts.map(act => (
                      <div 
                        key={act.id} 
                        onClick={() => { setSelectedAct(act); setSelectedInvoice(null); setSelectedWaybill(null); }}
                        className={`glass p-4 rounded-xl flex items-center justify-between cursor-pointer transition-all hover:border-slate-600 ${
                          selectedAct?.id === act.id ? 'ring-2 ring-indigo-500 border-transparent' : ''
                        }`}
                      >
                        <div className="space-y-1">
                          <p className="font-bold text-slate-100">{act.number}</p>
                          <p className="text-xs text-slate-400">{act.customer.name}</p>
                        </div>
                        <div className="flex items-center space-x-2">
                          <p className="font-bold text-slate-100">{Number(act.amount).toLocaleString()} ₸</p>
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
              <div className="glass rounded-2xl p-6 space-y-4">
                <h2 className="text-xl font-bold">Взаиморасчёты с контрагентами</h2>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm border-collapse">
                    <thead>
                      <tr className="border-b border-slate-800 text-slate-400 text-xs font-semibold uppercase">
                        <th className="pb-3">Контрагент</th>
                        <th className="pb-3 text-right">Выставлено</th>
                        <th className="pb-3 text-right">Оплачено</th>
                        <th className="pb-3 text-right">Задолженность</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {debtors.map(d => (
                        <tr key={d.customerId} className="hover:bg-slate-900/30">
                          <td className="py-4">
                            <p className="font-semibold text-slate-200">{d.customerName}</p>
                            <p className="text-[10px] text-slate-500">БИН: {d.bin}</p>
                          </td>
                          <td className="py-4 text-right font-medium">{d.totalBilled.toLocaleString()} ₸</td>
                          <td className="py-4 text-right font-medium text-emerald-400">{d.totalPaid.toLocaleString()} ₸</td>
                          <td className={`py-4 text-right font-bold ${d.outstandingDebt > 0 ? 'text-rose-400' : 'text-green-400'}`}>
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
                  <h2 className="text-xl font-bold">Заказы поставщикам (Purchase Orders)</h2>
                </div>

                {purchaseOrders.length === 0 ? (
                  <p className="text-slate-500 text-sm glass p-6 rounded-2xl text-center">Заказов поставщикам не найдено.</p>
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
                          className={`glass p-4 rounded-xl space-y-3 cursor-pointer transition-all hover:border-slate-600 ${
                            selectedPo?.id === po.id ? 'ring-2 ring-indigo-500 border-transparent' : ''
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="font-bold text-slate-100">{po.number}</p>
                              <p className="text-xs text-slate-400">Поставщик: {po.supplier?.name || 'Не указан'}</p>
                            </div>
                            <span className={`px-2 py-0.5 text-[10px] font-bold rounded-full ${
                              po.status === 'RECEIVED' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' :
                              po.status === 'PARTIALLY_RECEIVED' ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30' :
                              po.status === 'SENT' ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30' :
                              'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                            }`}>
                              {po.status === 'DRAFT' ? 'Черновик' :
                               po.status === 'SENT' ? 'Отправлен' :
                               po.status === 'PARTIALLY_RECEIVED' ? 'Частично получен' :
                               po.status === 'RECEIVED' ? 'Получен' : po.status}
                            </span>
                          </div>

                          <div className="space-y-1 text-xs">
                            <div className="flex justify-between text-[11px] text-slate-400">
                              <span>Прогресс прихода: {totalReceived} / {totalOrdered} шт ({progressPct}%)</span>
                            </div>
                            <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                              <div className="h-full bg-indigo-500 transition-all" style={{ width: `${progressPct}%` }}></div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Suppliers directory summary */}
                <div className="glass p-6 rounded-2xl space-y-4">
                  <h3 className="text-lg font-bold">Справочник поставщиков</h3>
                  <div className="divide-y divide-slate-800 text-xs">
                    {suppliers.length === 0 ? (
                      <p className="text-slate-500 text-center py-2">Поставщики не внесены.</p>
                    ) : (
                      suppliers.map(s => (
                        <div key={s.id} className="py-2.5 flex justify-between items-center">
                          <div>
                            <p className="font-bold text-slate-200">{s.name}</p>
                            <p className="text-[10px] text-slate-400">БИН: {s.bin || 'Не указан'} | Тел: {s.phone || '-'}</p>
                          </div>
                          <span className="text-[10px] font-mono text-slate-500">{s.email || ''}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}

          </div>

          {/* Document Inspection Side Panel (1 col) */}
          <div className="space-y-4">
            <h2 className="text-xl font-bold">Детали документа</h2>
            
            {/* Invoice Detail Inspector */}
            {selectedInvoice && (
              <div className="glass rounded-2xl p-6 space-y-6 relative overflow-hidden">
                <div className="flex justify-between items-start">
                  <div>
                    <h3 className="text-lg font-bold text-slate-100">{selectedInvoice.number}</h3>
                    <p className="text-xs text-slate-400 mt-1">Организация: {selectedInvoice.customer.name}</p>
                  </div>
                  <span className={`px-2.5 py-1 text-[10px] font-bold rounded-full ${getStatusBadgeClass(selectedInvoice.status)}`}>
                    {getStatusLabel(selectedInvoice.status)}
                  </span>
                </div>

                <div className="space-y-3">
                  <p className="text-xs font-bold uppercase tracking-wider text-slate-400">Спецификация</p>
                  <div className="divide-y divide-slate-800 text-xs">
                    {/* Items query check */}
                    {selectedInvoice.items && selectedInvoice.items.map((item: any) => (
                      <div key={item.id} className="py-2 flex justify-between">
                        <div>
                          <p className="font-medium text-slate-300">{item.name}</p>
                          <p className="text-[10px] text-slate-500">SKU: {item.sku}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-slate-200">{Number(item.quantity)} шт × {Number(item.price).toLocaleString()} ₸</p>
                          <p className="text-[10px] text-slate-500">НДС {Number(item.vatRate)}%: {Number(item.vatAmount).toLocaleString()} ₸</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="border-t border-slate-800 pt-4 space-y-2 text-xs">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Сумма НДС:</span>
                    <span className="font-semibold text-slate-200">{Number(selectedInvoice.vatAmount).toLocaleString()} ₸</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="font-bold text-slate-300">Итого с НДС:</span>
                    <span className="font-black text-slate-100">{Number(selectedInvoice.amount).toLocaleString()} ₸</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Уже оплачено:</span>
                    <span className="font-semibold text-green-400">{Number(selectedInvoice.paidAmount).toLocaleString()} ₸</span>
                  </div>
                </div>

                {/* Signing & Payments actions */}
                <div className="pt-2">
                  {selectedInvoice.status === 'DRAFT' && (
                    <button 
                      onClick={() => signDocument('invoice', selectedInvoice.id, selectedInvoice.number)}
                      className="w-full py-3 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-400 hover:to-purple-500 text-white font-bold rounded-xl transition-all flex items-center justify-center space-x-2 text-xs"
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
                          className="flex-1 px-3 py-2 text-xs rounded-xl border border-slate-700 bg-slate-900 text-slate-200 outline-none focus:border-indigo-500"
                        />
                        <button 
                          onClick={() => handlePayment(selectedInvoice.id)}
                          className="px-4 py-2 bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-bold rounded-xl text-xs flex items-center space-x-1"
                        >
                          <CreditCard className="w-4 h-4" />
                          <span>Оплатить</span>
                        </button>
                      </div>
                      <p className="text-[10px] text-slate-500 text-center">Оплата публикует <code>invoice.paid</code> для обновления сделки в CRM.</p>
                    </div>
                  )}

                  {selectedInvoice.status === 'PAID' && (
                    <div className="p-3 rounded-xl bg-green-500/10 border border-green-500/20 flex items-center space-x-2 text-xs text-green-400">
                      <CheckCircle className="w-4 h-4" />
                      <span>Счёт полностью оплачен. Данные синхронизированы с CRM.</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Waybill Detail Inspector */}
            {selectedWaybill && (
              <div className="glass rounded-2xl p-6 space-y-6">
                <div className="flex justify-between items-start">
                  <div>
                    <h3 className="text-lg font-bold text-slate-100">{selectedWaybill.number}</h3>
                    <p className="text-xs text-slate-400 mt-1">Клиент: {selectedWaybill.customer.name}</p>
                  </div>
                  <span className={`px-2.5 py-1 text-[10px] font-bold rounded-full ${getStatusBadgeClass(selectedWaybill.status)}`}>
                    {selectedWaybill.status === 'DRAFT' ? 'В пути' : 'Доставлен'}
                  </span>
                </div>

                <div className="space-y-3">
                  <p className="text-xs font-bold uppercase tracking-wider text-slate-400">Содержимое накладной</p>
                  <div className="divide-y divide-slate-800 text-xs">
                    {selectedWaybill.items && selectedWaybill.items.map((item: any) => (
                      <div key={item.id} className="py-2 flex justify-between">
                        <div>
                          <p className="font-medium text-slate-300">{item.name}</p>
                          <p className="text-[10px] text-slate-500">SKU: {item.sku}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-slate-200">{Number(item.quantity)} шт</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {selectedWaybill.esfDocument && (
                  <div className="p-3 rounded-xl bg-slate-900 border border-slate-800 space-y-2 text-xs">
                    <div className="flex justify-between items-center">
                      <span className="font-bold text-slate-300">Статус ИС ЭСФ:</span>
                      <span className={`px-2 py-0.5 text-[10px] font-bold rounded-full ${getEsfBadgeClass(selectedWaybill.esfDocument.status)}`}>
                        {getEsfLabel(selectedWaybill.esfDocument.status)}
                      </span>
                    </div>
                    {selectedWaybill.esfDocument.esfRegNumber && (
                      <p className="text-[11px] text-emerald-400 font-mono">
                        Рег. №: {selectedWaybill.esfDocument.esfRegNumber}
                      </p>
                    )}
                    {selectedWaybill.esfDocument.errorMessage && (
                      <p className="text-[11px] text-rose-400">
                        Ошибка: {selectedWaybill.esfDocument.errorMessage}
                      </p>
                    )}
                    {(selectedWaybill.esfDocument.status === 'FAILED' || selectedWaybill.esfDocument.status === 'REJECTED') && (
                      <button 
                        onClick={() => retryEsf('waybill', selectedWaybill.id)}
                        className="w-full py-2 mt-1 bg-rose-600 hover:bg-rose-500 text-white font-bold rounded-lg text-xs"
                      >
                        Повторить подачу ЭСФ
                      </button>
                    )}
                  </div>
                )}

                {selectedWaybill.status === 'DRAFT' && (
                  <button 
                    onClick={() => signDocument('waybill', selectedWaybill.id, selectedWaybill.number)}
                    className="w-full py-3 bg-gradient-to-r from-indigo-500 to-purple-600 text-white font-bold rounded-xl transition-all flex items-center justify-center space-x-2 text-xs"
                  >
                    <ShieldCheck className="w-4 h-4" />
                    <span>Подписать получение ЭЦП</span>
                  </button>
                )}
              </div>
            )}

            {/* Service Act Detail Inspector */}
            {selectedAct && (
              <div className="glass rounded-2xl p-6 space-y-6">
                <div className="flex justify-between items-start">
                  <div>
                    <h3 className="text-lg font-bold text-slate-100">{selectedAct.number}</h3>
                    <p className="text-xs text-slate-400 mt-1">Контрагент: {selectedAct.customer.name}</p>
                  </div>
                  <span className={`px-2.5 py-1 text-[10px] font-bold rounded-full ${getStatusBadgeClass(selectedAct.status)}`}>
                    {selectedAct.status === 'DRAFT' ? 'Ждет подписи' : 'Подписан'}
                  </span>
                </div>

                <div className="space-y-3">
                  <p className="text-xs font-bold uppercase tracking-wider text-slate-400">Выполненные услуги</p>
                  <div className="divide-y divide-slate-800 text-xs">
                    {selectedAct.items && selectedAct.items.map((item: any) => (
                      <div key={item.id} className="py-2 flex justify-between">
                        <div>
                          <p className="font-medium text-slate-300">{item.name}</p>
                          <p className="text-[10px] text-slate-500">SKU: {item.sku}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-slate-200">{Number(item.quantity)} усл</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {selectedAct.esfDocument && (
                  <div className="p-3 rounded-xl bg-slate-900 border border-slate-800 space-y-2 text-xs">
                    <div className="flex justify-between items-center">
                      <span className="font-bold text-slate-300">Статус ИС ЭСФ:</span>
                      <span className={`px-2 py-0.5 text-[10px] font-bold rounded-full ${getEsfBadgeClass(selectedAct.esfDocument.status)}`}>
                        {getEsfLabel(selectedAct.esfDocument.status)}
                      </span>
                    </div>
                    {selectedAct.esfDocument.esfRegNumber && (
                      <p className="text-[11px] text-emerald-400 font-mono">
                        Рег. №: {selectedAct.esfDocument.esfRegNumber}
                      </p>
                    )}
                    {selectedAct.esfDocument.errorMessage && (
                      <p className="text-[11px] text-rose-400">
                        Ошибка: {selectedAct.esfDocument.errorMessage}
                      </p>
                    )}
                    {(selectedAct.esfDocument.status === 'FAILED' || selectedAct.esfDocument.status === 'REJECTED') && (
                      <button 
                        onClick={() => retryEsf('act', selectedAct.id)}
                        className="w-full py-2 mt-1 bg-rose-600 hover:bg-rose-500 text-white font-bold rounded-lg text-xs"
                      >
                        Повторить подачу ЭСФ
                      </button>
                    )}
                  </div>
                )}

                {selectedAct.status === 'DRAFT' && (
                  <button 
                    onClick={() => signDocument('act', selectedAct.id, selectedAct.number)}
                    className="w-full py-3 bg-gradient-to-r from-indigo-500 to-purple-600 text-white font-bold rounded-xl transition-all flex items-center justify-center space-x-2 text-xs"
                  >
                    <ShieldCheck className="w-4 h-4" />
                    <span>Подписать АВР ЭЦП</span>
                  </button>
                )}
              </div>
            )}

            {!selectedInvoice && !selectedWaybill && !selectedAct && (
              <div className="glass rounded-2xl p-6 text-center text-slate-500 text-xs">
                Выберите документ в списке для детального просмотра и совершения действий.
              </div>
            )}

          </div>

        </div>

      </main>

    </div>
  );
}
