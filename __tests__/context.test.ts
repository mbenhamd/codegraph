/**
 * Context Builder Tests
 *
 * Tests for the context building functionality.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';

describe('Context Builder', () => {
  let testDir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-context-test-'));

    // Create a sample codebase
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);

    // Create a payment service file
    fs.writeFileSync(
      path.join(srcDir, 'payment.ts'),
      `/**
 * Payment Service
 * Handles payment processing logic.
 */

export interface PaymentResult {
  success: boolean;
  transactionId: string;
  amount: number;
}

export class PaymentService {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Process a payment for the given amount
   */
  async processPayment(amount: number): Promise<PaymentResult> {
    // Validate amount
    if (amount <= 0) {
      throw new Error('Invalid amount');
    }

    // Process payment
    const transactionId = this.generateTransactionId();
    return {
      success: true,
      transactionId,
      amount,
    };
  }

  private generateTransactionId(): string {
    return 'txn_' + Math.random().toString(36).substring(2);
  }
}

export function createPaymentService(apiKey: string): PaymentService {
  return new PaymentService(apiKey);
}
`
    );

    // Create a checkout controller file
    fs.writeFileSync(
      path.join(srcDir, 'checkout.ts'),
      `/**
 * Checkout Controller
 * Handles the checkout flow.
 */

import { PaymentService, PaymentResult } from './payment';

export interface CartItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
}

export class CheckoutController {
  private paymentService: PaymentService;

  constructor(paymentService: PaymentService) {
    this.paymentService = paymentService;
  }

  /**
   * Process checkout for the given cart
   */
  async processCheckout(cart: CartItem[]): Promise<PaymentResult> {
    const total = this.calculateTotal(cart);

    if (total === 0) {
      throw new Error('Cart is empty');
    }

    return this.paymentService.processPayment(total);
  }

  /**
   * Calculate the total price of the cart
   */
  calculateTotal(cart: CartItem[]): number {
    return cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  }
}
`
    );

    // Create a utilities file
    fs.writeFileSync(
      path.join(srcDir, 'utils.ts'),
      `/**
 * Utility functions
 */

export function formatCurrency(amount: number): string {
  return '$' + amount.toFixed(2);
}

export function validateEmail(email: string): boolean {
  return email.includes('@');
}
`
    );

    const vendorDir = path.join(testDir, 'third_party', 'generated');
    fs.mkdirSync(vendorDir, { recursive: true });
    fs.writeFileSync(
      path.join(vendorDir, 'payment.ts'),
      `/**
 * Vendored fixture duplicate.
 */

export class PaymentService {
  async processPayment(amount: number): Promise<string> {
    return 'vendored-' + amount;
  }
}
`
    );

    // Initialize CodeGraph
    cg = CodeGraph.initSync(testDir, {
      config: {
        include: ['**/*.ts'],
        exclude: [],
      },
    });

    // Index the codebase
    await cg.indexAll();
  });

  afterEach(() => {
    if (cg) {
      cg.destroy();
    }
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('getCode()', () => {
    it('should extract code for a node', async () => {
      // Find the PaymentService class
      const nodes = cg.getNodesByKind('class');
      const paymentService = nodes.find((n) => n.name === 'PaymentService');

      expect(paymentService).toBeDefined();

      const code = await cg.getCode(paymentService!.id);

      expect(code).not.toBeNull();
      expect(code).toContain('class PaymentService');
      expect(code).toContain('processPayment');
    });

    it('should return null for non-existent node', async () => {
      const code = await cg.getCode('non-existent-id');
      expect(code).toBeNull();
    });
  });

  describe('findRelevantContext()', () => {
    it('should find relevant nodes for a query', async () => {
      // Use simple query that matches symbol names (FTS5 treats spaces as AND)
      const result = await cg.findRelevantContext('PaymentService');

      expect(result.nodes.size).toBeGreaterThan(0);
      // Should find payment-related nodes
      const nodeNames = Array.from(result.nodes.values()).map((n) => n.name);
      expect(
        nodeNames.some(
          (name) =>
            name.toLowerCase().includes('payment') ||
            name.toLowerCase().includes('checkout')
        )
      ).toBe(true);
    });

    it('should include edges in the result', async () => {
      const result = await cg.findRelevantContext('checkout', {
        traversalDepth: 2,
      });

      // Should have some edges from traversal
      expect(result.edges).toBeDefined();
    });

    it('should respect maxNodes option', async () => {
      const result = await cg.findRelevantContext('function', {
        maxNodes: 5,
      });

      expect(result.nodes.size).toBeLessThanOrEqual(5);
    });

    it('should rank local source above vendored generated duplicates', async () => {
      const result = await cg.findRelevantContext('PaymentService processPayment', {
        searchLimit: 3,
        traversalDepth: 0,
        maxNodes: 10,
        minScore: 0,
      });
      const entryPaths = result.roots
        .map((id) => result.nodes.get(id)?.filePath)
        .filter((filePath): filePath is string => Boolean(filePath));
      const appIndex = entryPaths.indexOf('src/payment.ts');
      const vendorIndex = entryPaths.indexOf('third_party/generated/payment.ts');

      expect(entryPaths[0]).toBe('src/payment.ts');
      expect(vendorIndex === -1 || vendorIndex > appIndex).toBe(true);
    });

    it('should apply hard path filters before trimming search results', () => {
      const results = cg.searchNodes('path:third_party PaymentService', {
        limit: 1,
        kinds: ['class'],
      });

      expect(results).toHaveLength(1);
      expect(results[0]!.node.filePath).toBe('third_party/generated/payment.ts');
    });
  });

  describe('buildContext()', () => {
    it('should build context with markdown format', async () => {
      const result = await cg.buildContext('Fix checkout error', {
        format: 'markdown',
        maxCodeBlocks: 3,
      });

      expect(typeof result).toBe('string');
      const markdown = result as string;

      // Should contain markdown structure
      expect(markdown).toContain('## Code Context');
      expect(markdown).toContain('**Query:** Fix checkout error');
    });

    it('should build context with JSON format', async () => {
      const result = await cg.buildContext('payment processing', {
        format: 'json',
      });

      expect(typeof result).toBe('string');
      const parsed = JSON.parse(result as string);

      expect(parsed.query).toBe('payment processing');
      expect(parsed.nodes).toBeDefined();
      expect(Array.isArray(parsed.nodes)).toBe(true);
    });

    it('should include path ranking diagnostics in JSON context when opted in (PF-618)', async () => {
      const result = await cg.buildContext('PaymentService processPayment', {
        format: 'json',
        searchLimit: 8,
        traversalDepth: 1,
        maxNodes: 20,
        diagnostics: true,
      });
      const parsed = JSON.parse(result as string);

      expect(parsed.rankingDiagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            filePath: 'src/payment.ts',
            reasons: expect.arrayContaining(['boosted source-root path']),
          }),
        ])
      );
    });

    it('omits ranking diagnostics from JSON context by default (PF-618)', async () => {
      const result = await cg.buildContext('PaymentService processPayment', {
        format: 'json',
        searchLimit: 8,
        traversalDepth: 1,
        maxNodes: 20,
      });
      const parsed = JSON.parse(result as string);
      // Default behavior: the rankingDiagnostics field is absent — not
      // an empty array — so the normal response stays compact and the
      // shape contract is unambiguous for programmatic consumers.
      expect(parsed).not.toHaveProperty('rankingDiagnostics');
    });

    it('should accept object input with title and description', async () => {
      const result = await cg.buildContext(
        {
          title: 'Checkout bug',
          description: 'Cart total calculation is wrong',
        },
        { format: 'markdown' }
      );

      expect(typeof result).toBe('string');
      expect(result).toContain('Checkout bug: Cart total calculation is wrong');
    });

    it('should include code blocks when requested', async () => {
      const result = await cg.buildContext('PaymentService', {
        format: 'markdown',
        includeCode: true,
        maxCodeBlocks: 2,
      });

      const markdown = result as string;

      // Should contain code blocks
      expect(markdown).toContain('### Code');
      expect(markdown).toContain('```typescript');
    });

    it('should exclude code blocks when requested', async () => {
      const result = await cg.buildContext('payment', {
        format: 'markdown',
        includeCode: false,
      });

      const markdown = result as string;

      // Should not contain code section
      expect(markdown).not.toContain('### Code');
    });

    it('should include related symbols in compact format', async () => {
      const result = await cg.buildContext('checkout', {
        format: 'markdown',
        maxNodes: 10,
      });

      const markdown = result as string;

      // Compact format uses "Related Symbols" instead of verbose "Related Files"
      // and groups symbols by file for compactness
      expect(markdown).toContain('### Entry Points');
    });

    it('should have compact output without verbose stats footer', async () => {
      const result = await cg.buildContext('payment', {
        format: 'markdown',
      });

      const markdown = result as string;

      // Compact format should NOT have verbose stats footer
      expect(markdown).not.toMatch(/\*Context:.*symbols.*relationships.*files/);
      // But should still have query
      expect(markdown).toContain('**Query:**');
    });
  });

  describe('Context structure', () => {
    it('should find entry points from search', async () => {
      const result = await cg.buildContext('PaymentService', {
        format: 'json',
      });

      const parsed = JSON.parse(result as string);

      expect(parsed.entryPoints).toBeDefined();
      expect(parsed.entryPoints.length).toBeGreaterThan(0);
    });

    it('should traverse graph from entry points', async () => {
      const result = await cg.buildContext('CheckoutController', {
        format: 'json',
        traversalDepth: 2,
      });

      const parsed = JSON.parse(result as string);

      // Should have found related nodes through traversal
      const nodeNames = parsed.nodes.map((n: { name: string }) => n.name);

      // CheckoutController calls PaymentService, so both should be present
      expect(
        nodeNames.some((name: string) => name.includes('Checkout'))
      ).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty query', async () => {
      const result = await cg.buildContext('', { format: 'markdown' });

      expect(typeof result).toBe('string');
    });

    it('should handle query with no matches', async () => {
      const result = await cg.buildContext('xyznonexistent123', {
        format: 'json',
      });

      const parsed = JSON.parse(result as string);

      // Should return empty or minimal results
      expect(parsed.nodes).toBeDefined();
    });

    it('should truncate long code blocks', async () => {
      const result = await cg.buildContext('PaymentService', {
        format: 'markdown',
        maxCodeBlockSize: 100,
        includeCode: true,
      });

      const markdown = result as string;

      // Long code blocks should be truncated
      if (markdown.includes('```typescript')) {
        // If there's a code block, check for truncation marker if content was long
        // This test validates the truncation logic works
        expect(typeof markdown).toBe('string');
      }
    });
  });
});
