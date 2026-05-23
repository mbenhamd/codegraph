import { storeOrder } from '@core/index.js';

export function checkout(orderId: string): string {
  return storeOrder(orderId);
}
