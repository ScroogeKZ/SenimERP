import express from 'express';
import cors from 'cors';
import { signSsoToken } from '@senimerp/auth-client';
import { UserRole } from '@senimerp/types';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = 3001;

// Stub list of tenants
const MOCK_TENANTS = [
  { id: 'tenant_alpha', name: 'ТОО Senim Retail (БИН 990840001234)' },
  { id: 'tenant_beta', name: 'ТОО TechService (БИН 880740005678)' }
];

// Stub list of roles
const ROLE_LABELS: Record<UserRole, string> = {
  CRM_MANAGER: 'Менеджер по продажам (CRM)',
  CRM_LEAD: 'Руководитель отдела продаж (CRM)',
  ERP_ACCOUNTANT: 'Бухгалтер (ERP)',
  ERP_WAREHOUSE_MANAGER: 'Кладовщик (ERP)',
  ERP_PURCHASER: 'Снабженец (ERP)',
  ERP_CEO: 'Генеральный директор (ERP/CRM)'
};

app.get('/login', (req, res) => {
  const redirectUri = req.query.redirect_uri as string || 'http://localhost:3000'; // Fallback to CRM or ERP port
  
  // Render a clean, premium HTML login portal directly
  const html = `
    <!DOCTYPE html>
    <html lang="ru">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Senim SSO — Единая авторизация</title>
      <style>
        body {
          margin: 0;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
          background: radial-gradient(circle at top right, #1e1b4b, #0f172a);
          color: #f8fafc;
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
        }
        .container {
          background: rgba(30, 41, 59, 0.7);
          backdrop-filter: blur(16px);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 16px;
          padding: 32px;
          width: 100%;
          max-width: 420px;
          box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.5);
        }
        .header {
          text-align: center;
          margin-bottom: 24px;
        }
        .logo {
          font-size: 28px;
          font-weight: 800;
          letter-spacing: -0.05em;
          background: linear-gradient(to right, #6366f1, #a855f7);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          margin-bottom: 8px;
        }
        .title {
          font-size: 18px;
          color: #94a3b8;
        }
        .form-group {
          margin-bottom: 20px;
        }
        label {
          display: block;
          font-size: 13px;
          font-weight: 600;
          color: #94a3b8;
          margin-bottom: 8px;
        }
        select, input {
          width: 100%;
          padding: 12px;
          border-radius: 8px;
          border: 1px solid rgba(255, 255, 255, 0.15);
          background: rgba(15, 23, 42, 0.6);
          color: #f8fafc;
          font-size: 14px;
          box-sizing: border-box;
          outline: none;
          transition: border 0.2s;
        }
        select:focus, input:focus {
          border-color: #6366f1;
        }
        .checkbox-group {
          max-height: 150px;
          overflow-y: auto;
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 8px;
          background: rgba(15, 23, 42, 0.4);
          padding: 12px;
        }
        .checkbox-item {
          display: flex;
          align-items: center;
          margin-bottom: 8px;
        }
        .checkbox-item:last-child {
          margin-bottom: 0;
        }
        .checkbox-item input {
          width: auto;
          margin-right: 10px;
        }
        button {
          width: 100%;
          padding: 14px;
          background: linear-gradient(to right, #6366f1, #a855f7);
          border: none;
          border-radius: 8px;
          color: #ffffff;
          font-weight: 700;
          font-size: 15px;
          cursor: pointer;
          transition: opacity 0.2s;
          margin-top: 10px;
        }
        button:hover {
          opacity: 0.9;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="logo">Senim SSO</div>
          <div class="title">Единый вход в CRM и ERP</div>
        </div>
        <form method="POST" action="/login">
          <input type="hidden" name="redirectUri" value="${redirectUri}">
          
          <div class="form-group">
            <label for="email">Электронная почта</label>
            <input type="email" id="email" name="email" value="accountant@senim.kz" required>
          </div>

          <div class="form-group">
            <label for="tenantId">Организация (Tenant)</label>
            <select id="tenantId" name="tenantId">
              ${MOCK_TENANTS.map(t => `<option value="${t.id}">${t.name}</option>`).join('')}
            </select>
          </div>

          <div class="form-group">
            <label>Доступные роли</label>
            <div class="checkbox-group">
              ${Object.entries(ROLE_LABELS).map(([role, label]) => `
                <div class="checkbox-item">
                  <input type="checkbox" name="roles" value="${role}" id="role_${role}" ${role === 'ERP_ACCOUNTANT' || role === 'CRM_MANAGER' ? 'checked' : ''}>
                  <label for="role_${role}" style="display:inline; margin-bottom:0; font-weight:normal; color:#e2e8f0;">${label}</label>
                </div>
              `).join('')}
            </div>
          </div>

          <button type="submit">Войти в систему</button>
        </form>
      </div>
    </body>
    </html>
  `;
  res.send(html);
});

app.post('/login', (req, res) => {
  const { email, tenantId, redirectUri } = req.body;
  let roles = req.body.roles as UserRole[];
  if (!roles) {
    roles = [];
  } else if (!Array.isArray(roles)) {
    roles = [roles];
  }

  // Generate mock user sub id
  const sub = `usr_${email.split('@')[0]}_test`;

  // Sign SSO token
  const token = signSsoToken({
    sub,
    email,
    tenantId,
    roles
  });

  // Redirect back to target client with token
  const redirectUrl = new URL(redirectUri);
  redirectUrl.searchParams.set('sso_token', token);
  res.redirect(redirectUrl.toString());
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Mock SSO identity provider listening on http://localhost:${PORT}`);
});
