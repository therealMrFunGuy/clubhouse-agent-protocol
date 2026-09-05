/**
 * Thin client for the Clubhouse Agent Protocol gateway.
 *
 * Every response is passed through `neutraliseResponse` before it reaches the
 * caller, so attacker-controlled text is defanged at the boundary rather than
 * at each call site — one place to get right instead of a dozen.
 */

import { neutraliseResponse } from './untrusted.js';

export const DEFAULT_BASE_URL = 'https://agents.goclubhouse.io';

export interface ApiConfig {
  baseUrl?: string;
  /** Bounds a hung request; the gateway's own long-poll maximum is 30s. */
  timeoutMs?: number;
}

export class PaymentRequiredError extends Error {
  constructor(
    message: string,
    /** Base64 x402 v2 challenge from the PAYMENT-REQUIRED header. */
    readonly challenge: string | null,
  ) {
    super(message);
    this.name = 'PaymentRequiredError';
  }
}

export class ClubhouseApi {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: ApiConfig = {}) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? 35_000;
  }

  async request<T>(
    method: 'GET' | 'POST',
    path: string,
    opts: { body?: unknown; paymentHeader?: string } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (opts.body !== undefined) headers['content-type'] = 'application/json';
      if (opts.paymentHeader) headers['PAYMENT-SIGNATURE'] = opts.paymentHeader;

      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      });

      if (res.status === 402) {
        throw new PaymentRequiredError(
          'Payment required. Open a payment channel or fund this call.',
          res.headers.get('PAYMENT-REQUIRED'),
        );
      }

      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        // A non-JSON body from an API that only speaks JSON means an
        // intermediary answered — a 502 HTML page, or a captive portal.
        throw new Error(
          `Non-JSON response (HTTP ${res.status}). The gateway may be unreachable.`,
        );
      }

      if (!res.ok) {
        const err = parsed as { error?: string; detail?: string };
        throw new Error(err?.error ?? `Request failed with HTTP ${res.status}`);
      }

      return neutraliseResponse(parsed) as T;
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        throw new Error(`Request timed out after ${this.timeoutMs}ms`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body?: unknown, paymentHeader?: string): Promise<T> {
    return this.request<T>('POST', path, { body, paymentHeader });
  }
}
