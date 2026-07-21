import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { TenantPrismaService } from './prisma.service.js';

function escapeXml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Simple in-memory cache for CRM product details (TTL 15 minutes)
interface ProductDetails {
  name: string;
  price: number;
  brand?: string;
  sku: string;
}

const crmProductCache = new Map<string, { data: ProductDetails; timestamp: number }>();
const CACHE_TTL_MS = 15 * 60 * 1000;

@Controller('api/marketplace')
export class MarketplaceController {
  constructor(private readonly prismaService: TenantPrismaService) {}

  /**
   * Helper to fetch CRM products and populate in-memory cache.
   */
  private async getCrmProductDetails(sku: string, crmProductId?: string): Promise<ProductDetails | null> {
    const cacheKey = crmProductId || sku;
    const cached = crmProductCache.get(cacheKey);
    const now = Date.now();

    if (cached && now - cached.timestamp < CACHE_TTL_MS) {
      return cached.data;
    }

    try {
      // Attempt to query CRM products API
      const res = await fetch(`http://localhost:3000/api/products`);
      if (res.ok) {
        const products: any[] = await res.json();
        for (const p of products) {
          const key = p.id || p.sku;
          crmProductCache.set(key, {
            data: {
              name: p.name,
              price: Number(p.price || 0),
              brand: p.brand || p.manufacturer || undefined,
              sku: p.sku || sku
            },
            timestamp: now
          });
          if (p.sku) {
            crmProductCache.set(p.sku, {
              data: {
                name: p.name,
                price: Number(p.price || 0),
                brand: p.brand || p.manufacturer || undefined,
                sku: p.sku
              },
              timestamp: now
            });
          }
        }
        const updated = crmProductCache.get(cacheKey);
        if (updated) return updated.data;
      }
    } catch {
      // If CRM server is unreachable, check cached or return null
    }

    return crmProductCache.get(cacheKey)?.data || null;
  }

  /**
   * Public Kaspi.kz XML Catalog Export Endpoint.
   * Kaspi polls this URL periodically without SSO Bearer tokens.
   */
  @Get('kaspi/:accountId/catalog.xml')
  async getKaspiCatalog(
    @Param('accountId') accountId: string,
    @Query('warehouseId') warehouseIdQuery: string | undefined,
    @Query('tenantId') tenantIdQuery: string | undefined,
    @Res() res: Response
  ) {
    const tenantId = tenantIdQuery || 'tenant_default';
    await this.prismaService.ensureTenantSchema(tenantId);
    const db = this.prismaService.getClient(tenantId);

    let targetWarehouseId = warehouseIdQuery;
    if (!targetWarehouseId) {
      const defaultWh = await db.warehouse.findFirst({ where: { isDefault: true } });
      targetWarehouseId = defaultWh?.id || 'default-main-warehouse';
    }

    const stockItems = await db.stockItem.findMany({
      where: { warehouseId: targetWarehouseId }
    });

    const offerXmlNodes: string[] = [];

    for (const item of stockItems) {
      const stockCount = Math.max(0, Number(item.quantity) - Number(item.reserved));
      const available = stockCount > 0 ? 'yes' : 'no';

      // Try to get enriched product details from CRM or cache
      const details = await this.getCrmProductDetails(item.sku, item.crmProductId || undefined);

      // Also check if we can get product name/price from ERP historical line items if missing
      let name = details?.name;
      let price = details?.price;
      let brand = details?.brand;

      if (!name || price === undefined || price === null || price === 0) {
        // Look up historical WaybillLineItem or InvoiceLineItem for this SKU
        const historicalItem = await db.waybillLineItem.findFirst({
          where: { sku: item.sku }
        }) || await db.invoiceLineItem.findFirst({
          where: { sku: item.sku }
        });

        if (historicalItem) {
          name = name || historicalItem.name;
          price = price || Number(historicalItem.price);
        }
      }

      // If item lacks name or price, exclude it from catalog output to prevent Kaspi rejection
      if (!name || price === undefined || price === null) {
        continue;
      }

      const offerXml = `    <offer sku="${escapeXml(item.sku)}">
      <model>${escapeXml(name)}</model>
${brand ? `      <brand>${escapeXml(brand)}</brand>\n` : ''}      <availabilities>
        <availability available="${available}" storeId="${escapeXml(targetWarehouseId)}" stockCount="${stockCount}"/>
      </availabilities>
      <price>${price}</price>
    </offer>`;

      offerXmlNodes.push(offerXml);
    }

    const xmlCatalog = `<?xml version="1.0" encoding="UTF-8"?>
<kaspi_catalog date="${new Date().toISOString()}" xmlns="kaspiShopping" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="kaspiShopping http://kaspi.kz/kaspishopping.xsd">
  <company>SenimERP</company>
  <merchantid>${escapeXml(accountId)}</merchantid>
  <offers>
${offerXmlNodes.join('\n')}
  </offers>
</kaspi_catalog>`;

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.status(200).send(xmlCatalog);
  }
}
