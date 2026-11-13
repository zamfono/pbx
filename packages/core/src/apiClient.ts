/**
 * A small fetch wrapper over `api`'s internal HTTP API (§3, §3.1): `core` posts a voicemail or
 * missed-call mail request to `api`'s `/internal/mail`, which accepts it and renders and sends the
 * mail itself, retrying on its own (§10.2 "Failure"), and a source address that reached the SIP
 * ban threshold to `/internal/sipBan` (§5.6), each with `INTERNAL_TOKEN` as its bearer token. This
 * client makes one request and does not retry.
 */
import {
  internalAuthorization,
  type MailRequest,
  type SipBanReport
} from '@zamfono/shared';

export class ApiClient {
  private readonly baseUrl: string;
  private readonly token: string;

  /** `baseUrl` is `CoreEnv.apiInternalUrl`, `token` `CoreEnv.internalToken`, which every request
   * carries as its bearer token (§3.1). */
  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl;
    this.token = token;
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
      headers: {
        'Content-Type': 'application/json',
        ...internalAuthorization(this.token)
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new Error(`apiClient: POST ${path} responded ${response.status}`);
    }
  }
}
