import { describe, it, expect, vi } from 'vitest';
import { PayomSmsProvider } from '../sms.provider.js';

describe('PayomSmsProvider Integration Tests', () => {
  const SECRET_TOKEN = 'secret_test_bearer_token_12345';

  it('should use default Sender Name TOZON-PLAZA', async () => {
    const provider = new PayomSmsProvider({ token: SECRET_TOKEN });
    const result = await provider.sendSms({ phone: '+992927779757', text: 'Тест' });
    expect(result.senderName).toBe('TOZON-PLAZA');
  });

  it('should return mock response in test environment without throwing', async () => {
    const provider = new PayomSmsProvider({ token: null });
    const result = await provider.sendSms({ phone: '+992927779757', text: 'Тест' });
    expect(result.success).toBe(true);
    expect(result.isMock).toBe(true);
    expect(result.providerMessageId).toContain('MOCK_PAYOM_');
  });

  it('should handle 401 Unauthorized from Payom gateway without leaking token', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ message: 'Unauthenticated' })
    });

    const provider = new PayomSmsProvider({
      token: SECRET_TOKEN,
      fetchFn: mockFetch
    });

    // Temporarily unset mock mode to trigger fetch call
    const origMockMode = process.env.PAYOM_MOCK_MODE;
    const origNodeEnv = process.env.NODE_ENV;
    delete process.env.PAYOM_MOCK_MODE;
    process.env.NODE_ENV = 'production';

    try {
      const result = await provider.sendSms({ phone: '+992927779757', text: 'Тестовое сообщение' });
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('PAYOM_UNAUTHORIZED');
      expect(result.errorMessage).not.toContain(SECRET_TOKEN);
    } finally {
      process.env.PAYOM_MOCK_MODE = origMockMode;
      process.env.NODE_ENV = origNodeEnv;
    }
  });

  it('should handle 4xx client error response from Payom', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ message: 'Invalid telephone format' })
    });

    const provider = new PayomSmsProvider({
      token: SECRET_TOKEN,
      fetchFn: mockFetch
    });

    const origNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
      const result = await provider.sendSms({ phone: '+992927779757', text: 'Тест' });
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('PAYOM_HTTP_400');
      expect(result.errorMessage).toBe('Invalid telephone format');
    } finally {
      process.env.NODE_ENV = origNodeEnv;
    }
  });

  it('should handle 5xx server error from Payom', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ message: 'Service Unavailable' })
    });

    const provider = new PayomSmsProvider({
      token: SECRET_TOKEN,
      fetchFn: mockFetch
    });

    const origNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
      const result = await provider.sendSms({ phone: '+992927779757', text: 'Тест' });
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('PAYOM_HTTP_503');
    } finally {
      process.env.NODE_ENV = origNodeEnv;
    }
  });

  it('should handle request timeout', async () => {
    const mockFetch = vi.fn().mockImplementation(() => {
      return new Promise((_, reject) => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        setTimeout(() => reject(err), 50);
      });
    });

    const provider = new PayomSmsProvider({
      token: SECRET_TOKEN,
      timeoutMs: 10,
      fetchFn: mockFetch
    });

    const origNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
      const result = await provider.sendSms({ phone: '+992927779757', text: 'Тест' });
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('PAYOM_TIMEOUT');
    } finally {
      process.env.NODE_ENV = origNodeEnv;
    }
  });

  it('should ensure Bearer token is NEVER present in error output or messages', () => {
    const provider = new PayomSmsProvider({ token: SECRET_TOKEN });
    const err = new Error(`Failed request with token ${SECRET_TOKEN}`);
    const sanitized = provider._sanitizeErrorMessage(err, SECRET_TOKEN);
    expect(sanitized).not.toContain(SECRET_TOKEN);
    expect(sanitized).toContain('[REDACTED_PAYOM_TOKEN]');
  });
});
