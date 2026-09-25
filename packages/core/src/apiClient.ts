/**
 * A small fetch wrapper over `api`'s internal HTTP API (§3, §3.1 "Mail"): `core` posts a
 * voicemail or missed-call mail request to `api`'s `/internal/mail`, which accepts it and renders
 * and sends the mail itself, retrying on its own (§10.2 "Failure") — this client makes one
 * request and does not retry.
 */
import process from 'node:process';

import type { MailRequest } from '@zamfono/shared';

const DEFAULT_API_INTERNAL_URL = 'http://api:3000';

export class ApiClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string = process.env.API_INTERNAL_URL ?? DEFAULT_API_INTERNAL_URL
  ) {
    this.baseUrl = baseUrl;
  }

  async mail(req: MailRequest): Promise<void> {
    const response = await fetch(`${this.baseUrl}/internal/mail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req)
    });
    if (!response.ok) {
      throw new Error(
        `apiClient: POST /internal/mail responded ${response.status}`
      );
    }
  }
}
