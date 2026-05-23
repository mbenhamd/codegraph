import express from 'express';

export const app = express();

export function listOrders(_req: unknown, res: { json(body: string[]): void }): void {
  res.json(['first-order']);
}

app.get('/orders', listOrders);
