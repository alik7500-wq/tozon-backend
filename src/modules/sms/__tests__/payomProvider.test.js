import { describe, it, expect, vi } from 'vitest';
import { PayomSmsProvider } from '../sms.provider.js';

describe('PayomSmsProvider Integration Tests', () => {
  const SECRET_TOKEN = 'secret_test_bearer_token_12345';

  it('should use default Sender Name TOZON-PLAZA', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'PAYOM_12345' })
    });
    const provider = new PayomSmsProvider({ token: SECRET_TOKEN, fetchFn: mockFetch });

    const origNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
      const result = await provider.sendSms({ phone: '+992927779757', text: 'Тест' });
      expect(result.senderName).toBe('TOZON-PLAZA');
    } finally {
      process.env.NODE_ENV = origNodeEnv;
    }
  });

  it('should return mock response in test/dev environment when mock is enabled', async () => {
    const provider = new PayomSmsProvider({ token: null });
    const origNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';

    try {
      const result = await provider.sendSms({ phone: '+992927779757', text: 'Тест' });
      expect(result.success).toBe(true);
      expect(result.isMock).toBe(true);
      expect(result.providerMessageId).toContain('MOCK_PAYOM_');
    } finally {
      process.env.NODE_ENV = origNodeEnv;
    }
  });

  it('should FAIL-CLOSED in production if PAYOM_API_TOKEN is missing', async () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origToken = process.env.PAYOM_API_TOKEN;
    process.env.NODE_ENV = 'production';
    delete process.env.PAYOM_API_TOKEN;

    const mockFetch = vi.fn();
    const provider = new PayomSmsProvider({ token: null, fetchFn: mockFetch });

    try {
      const result = await provider.sendSms({ phone: '+992927779757', text: 'Тест' });
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('PAYOM_CONFIGURATION_ERROR');
      expect(result.errorMessage).toContain('PAYOM_API_TOKEN is missing in production environment');
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = origNodeEnv;
      if (origToken) process.env.PAYOM_API_TOKEN = origToken;
    }
  });

  it('should FAIL-CLOSED in production if PAYOM_MOCK_MODE is true', async () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origMock = process.env.PAYOM_MOCK_MODE;
    process.env.NODE_ENV = 'production';
    process.env.PAYOM_MOCK_MODE = 'true';

    const mockFetch = vi.fn();
    const provider = new PayomSmsProvider({ token: SECRET_TOKEN, fetchFn: mockFetch });

    try {
      const result = await provider.sendSms({ phone: '+992927779757', text: 'Тест' });
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('PAYOM_MOCK_MODE_PROHIBITED_IN_PRODUCTION');
      expect(result.errorMessage).toContain('PAYOM_MOCK_MODE is prohibited in production environment');
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = origNodeEnv;
      if (origMock !== undefined) process.env.PAYOM_MOCK_MODE = origMock;
      else delete process.env.PAYOM_MOCK_MODE;
    }
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
      if (origMockMode !== undefined) process.env.PAYOM_MOCK_MODE = origMockMode;
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
