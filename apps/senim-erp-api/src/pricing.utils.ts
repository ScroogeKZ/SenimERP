import { Prisma } from '@prisma/client';

/**
 * Calculates line VAT amount and total line amount including VAT using Prisma.Decimal.
 */
export function calculateLineAmounts(
  price: Prisma.Decimal | number | string,
  qty: Prisma.Decimal | number | string,
  vatRate: Prisma.Decimal | number | string
) {
  const priceDecimal = new Prisma.Decimal(price);
  const qtyDecimal = new Prisma.Decimal(qty);
  const vatRateDecimal = new Prisma.Decimal(vatRate);

  const lineTotalExcludingVat = priceDecimal.mul(qtyDecimal);
  const vatAmount = lineTotalExcludingVat.mul(vatRateDecimal).div(100).toDecimalPlaces(2);
  const totalAmount = lineTotalExcludingVat.plus(vatAmount).toDecimalPlaces(2);

  return { vatAmount, totalAmount };
}

/**
 * Calculates line discount amount and percentage metadata using Prisma.Decimal.
 */
export function calculateLineDiscount(
  listPrice: Prisma.Decimal | number | string | null | undefined,
  unitPrice: Prisma.Decimal | number | string,
  quantity: Prisma.Decimal | number | string
) {
  if (listPrice == null) {
    return {
      originalPrice: null,
      discountAmount: new Prisma.Decimal(0),
      discountPercent: new Prisma.Decimal(0)
    };
  }
  const originalPrice = new Prisma.Decimal(listPrice);
  const unitPriceDecimal = new Prisma.Decimal(unitPrice);
  const qtyDecimal = new Prisma.Decimal(quantity);

  const discountAmount = originalPrice.minus(unitPriceDecimal).mul(qtyDecimal).toDecimalPlaces(2);
  const discountPercent = originalPrice.gt(0)
    ? originalPrice.minus(unitPriceDecimal).div(originalPrice).mul(100).toDecimalPlaces(2)
    : new Prisma.Decimal(0);

  return { originalPrice, discountAmount, discountPercent };
}
