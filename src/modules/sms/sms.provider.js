/**
 * Base SMS Provider Interface and Payom.tj Implementation.
 */

export class BaseSmsProvider {
  async sendSms({ phone, text, senderName }) {
    throw new Error('sendSms method must be implemented by subclass');
  }
}

export class PayomSmsProvider extends BaseSmsProvider {
  constructor(config = {}) {
    super();
    this.baseUrl = (config.baseUrl || process.env.PAYOM_API_BASE_URL || 'https://gateway.payom.tj/api').replace(/\/+$/, '');
    this.token = config.token || process.env.PAYOM_API_TOKEN || null;
    this.defaultSenderName = config.senderName || process.env.PAYOM_SENDER_NAME || 'TOZON-PLAZA';
    this.timeoutMs = config.timeoutMs || 10000; // 10s default
    this.fetchFn = config.fetchFn || fetch;
  }

  /**
   * Sanitizes error message so secret tokens are never exposed in logs or stack traces.
   */
  _sanitizeErrorMessage(error, token) {
    if (!error) return 'Unknown error';
    let msg = error.message || String(error);
    if (token) {
      msg = msg.replaceAll(token, '[REDACTED_PAYOM_TOKEN]');
    }
    return msg;
  }

  /**
   * Sends SMS message via Payom.tj API.
   * Format according to official Payom.tj documentation:
   * POST /api/message
   * Headers:
   *   Accept: application/json
   *   Content-Type: application/json
   *   Authorization: Bearer <TOKEN>
   * Body:
   *   { "telephone": "+992XXXXXXXXX", "text": "...", "senderName": "TOZON-PLAZA", "type": "SMS" }
   */
  async sendSms({ phone, text, senderName }) {
    const finalSenderName = senderName || this.defaultSenderName;

    // Check if token is present or if mock mode is requested
    if (!this.token || process.env.PAYOM_MOCK_MODE === 'true' || process.env.NODE_ENV === 'test') {
      // Return safe mock response if token is not configured or in mock/test mode
      return {
        success: true,
        providerMessageId: `MOCK_PAYOM_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        status: 'sent',
        isMock: true,
        senderName: finalSenderName,
        phone,
        responseRaw: { status: 'mock_accepted', code: 200 }
      };
    }

    const endpoint = `${this.baseUrl}/message`;
    const payload = {
      telephone: phone,
      text: text,
      senderName: finalSenderName,
      type: 'SMS'
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timer);

      let responseData;
      try {
        responseData = await response.json();
      } catch {
        responseData = { rawText: 'Non-JSON response from Payom' };
      }

      if (response.status === 401) {
        return {
          success: false,
          status: 'failed',
          errorCode: 'PAYOM_UNAUTHORIZED',
          errorMessage: 'Payom Authorization failed (401 Bad or missing Bearer token)',
          responseRaw: responseData
        };
      }

      if (!response.ok) {
        return {
          success: false,
          status: 'failed',
          errorCode: `PAYOM_HTTP_${response.status}`,
          errorMessage: responseData.message || responseData.error || `Payom gateway returned HTTP status ${response.status}`,
          responseRaw: responseData
        };
      }

      // Check success indication from Payom response
      const providerMessageId = responseData.id || responseData.messageId || responseData.data?.id || `PAYOM_${Date.now()}`;

      return {
        success: true,
        providerMessageId: String(providerMessageId),
        status: 'sent',
        isMock: false,
        senderName: finalSenderName,
        phone,
        responseRaw: responseData
      };

    } catch (err) {
      clearTimeout(timer);

      const isAbort = err.name === 'AbortError';
      const sanitizedError = this._sanitizeErrorMessage(err, this.token);

      return {
        success: false,
        status: 'failed',
        errorCode: isAbort ? 'PAYOM_TIMEOUT' : 'PAYOM_NETWORK_ERROR',
        errorMessage: isAbort ? `Payom API request timed out after ${this.timeoutMs}ms` : sanitizedError,
        responseRaw: null
      };
    }
  }
}
