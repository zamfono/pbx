/**
 * A small fetch wrapper over `api`'s internal HTTP API (§3, §3.1): `core` posts a voicemail or
 * missed-call mail request to `api`'s `/internal/mail`, which accepts it and renders and sends the
 * mail itself, retrying on its own (§10.2 "Failure"), and a source address that reached the SIP
 * ban threshold to `/internal/sipBan` (§5.6). This client makes one request and does not retry.
 */
import type { MailRequest, SipBanReport } from '@zamfono/shared';

export class ApiClient {
  private readonly baseUrl: string;

  /** `baseUrl` is `CoreEnv.apiInternalUrl`. */
  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  mail(req: MailRequest): Promise<void> {
    return this.post('/internal/mail', req);
  }

  sipBan(report: SipBanReport): Promise<void> {
    return this.post('/internal/sipBan', report);
  }

  private async post(path: string, body: unknown): Promise<void> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new Error(`apiClient: POST ${path} responded ${response.status}`);
    }
  }
}
