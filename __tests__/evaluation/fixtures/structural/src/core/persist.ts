export function persistOrder(orderId: string): string {
  return `persisted:${orderId}`;
}

export function duplicateName(): string {
  return 'core';
}
