import { createHash } from 'node:crypto';
import { Agent, request } from 'undici';

export class AuthSessionFailedError extends Error {
  constructor(message = 'Failed to obtain auth session from Flattrade') {
    super(message);
    this.name = 'AuthSessionFailedError';
  }
}

export class InvalidOtpError extends Error {
  constructor(message = 'Invalid OTP or credentials') {
    super(message);
    this.name = 'InvalidOtpError';
  }
}

export class FallbackRequiredError extends Error {
  constructor(message = 'Flattrade requires browser authentication (CAPTCHA or changed flow)') {
    super(message);
    this.name = 'FallbackRequiredError';
  }
}

export class TokenExchangeError extends Error {
  constructor(message = 'Failed to exchange request code for daily session token') {
    super(message);
    this.name = 'TokenExchangeError';
  }
}

export interface FlattradeAuthConfig {
  userId: string;
  passwordSha256: string;
  apiKey: string;
  apiSecret: string;
  authBaseUrl?: string; // default: https://authapi.flattrade.in
  timeoutMs?: number; // default: 10000 (10s)
}

export class FlattradeAuthClient {
  private readonly config: FlattradeAuthConfig;
  private readonly authBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly dispatcher: Agent;

  constructor(config: FlattradeAuthConfig) {
    this.config = config;
    this.authBaseUrl = (config.authBaseUrl ?? 'https://authapi.flattrade.in').replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? 10000;
    this.dispatcher = new Agent({
      keepAliveTimeout: 30000,
      keepAliveMaxTimeout: 60000,
    });
  }

  /**
   * Executes the 3-step Flattrade authentication handshake from the static IP:
   * 1. POST /auth/session -> obtain sid
   * 2. POST /ftauth -> authenticate with userId, passwordSha256, and OTP/TOTP -> obtain code
   * 3. POST /trade/apitoken -> exchange code with SHA256(apiKey + code + apiSecret) -> obtain daily token
   *
   * @param otp 6-digit SMS OTP or TOTP string
   * @returns Daily session token (jKey)
   */
  async authenticateWithDailyOtp(otp: string): Promise<string> {
    // -------------------------------------------------------------
    // Step 1: Get Auth Session ID (sid)
    // -------------------------------------------------------------
    const step1Url = `${this.authBaseUrl}/auth/session`;
    let sid = '';

    try {
      const res = await request(step1Url, {
        method: 'POST',
        headers: {
          Origin: 'https://auth.flattrade.in',
          Referer: 'https://auth.flattrade.in/',
          'User-Agent': 'Mozilla/5.0',
        },
        dispatcher: this.dispatcher,
        headersTimeout: this.timeoutMs,
        bodyTimeout: this.timeoutMs,
      });

      if (res.statusCode !== 200) {
        throw new AuthSessionFailedError();
      }

      const bodyText = await res.body.text();
      sid = bodyText.trim().replace(/^"|"$/g, '');
      if (!sid) {
        throw new AuthSessionFailedError();
      }
    } catch (err: unknown) {
      if (err instanceof AuthSessionFailedError) throw err;
      throw new AuthSessionFailedError();
    }

    // -------------------------------------------------------------
    // Step 2: Authenticate Credentials + Manual 6-Digit OTP/TOTP
    // -------------------------------------------------------------
    const step2Url = `${this.authBaseUrl}/ftauth`;
    const ftauthPayload = {
      UserName: this.config.userId,
      Password: this.config.passwordSha256,
      PAN_DOB: otp,
      App: '',
      imei: '',
      Source: 'API',
      ApkVersion: '1.0.0',
      Sid: sid,
    };

    let requestCode = '';

    try {
      const res = await request(step2Url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://auth.flattrade.in',
          Referer: 'https://auth.flattrade.in/',
          'User-Agent': 'Mozilla/5.0',
        },
        body: JSON.stringify(ftauthPayload),
        dispatcher: this.dispatcher,
        headersTimeout: this.timeoutMs,
        bodyTimeout: this.timeoutMs,
      });

      const bodyText = await res.body.text();
      let resJson: Record<string, unknown> = {};
      try {
        resJson = JSON.parse(bodyText);
      } catch {
        throw new FallbackRequiredError('Invalid JSON response received from /ftauth');
      }

      // Check for error message from Flattrade (e.g., Invalid OTP / Invalid credentials)
      if (resJson.emsg && typeof resJson.emsg === 'string' && resJson.emsg.trim().length > 0) {
        // Do not reflect broker supplied text: it is outside our control and may contain secrets.
        throw new InvalidOtpError();
      }

      // Extract RedirectURL and query param 'code'
      const redirectUrlStr = typeof resJson.RedirectURL === 'string' ? resJson.RedirectURL : undefined;
      if (!redirectUrlStr) {
        throw new FallbackRequiredError('Flattrade did not return RedirectURL. Browser fallback required.');
      }

      try {
        const parsedUrl = new URL(redirectUrlStr);
        const code = parsedUrl.searchParams.get('code');
        if (!code) {
          throw new FallbackRequiredError('RedirectURL missing code parameter. Browser fallback required.');
        }
        requestCode = code;
      } catch (err) {
        if (err instanceof FallbackRequiredError) throw err;
        throw new FallbackRequiredError('Malformed RedirectURL in /ftauth response');
      }
    } catch (err: unknown) {
      if (err instanceof InvalidOtpError || err instanceof FallbackRequiredError) {
        throw err;
      }
      throw new FallbackRequiredError();
    }

    // -------------------------------------------------------------
    // Step 3: Exchange code for Daily Session Token
    // -------------------------------------------------------------
    const step3Url = `${this.authBaseUrl}/trade/apitoken`;
    const apiSecretHash = createHash('sha256')
      .update(this.config.apiKey + requestCode + this.config.apiSecret)
      .digest('hex');

    const tokenPayload = {
      api_key: this.config.apiKey,
      request_code: requestCode,
      api_secret: apiSecretHash,
    };

    try {
      const res = await request(step3Url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(tokenPayload),
        dispatcher: this.dispatcher,
        headersTimeout: this.timeoutMs,
        bodyTimeout: this.timeoutMs,
      });

      const bodyText = await res.body.text();
      let resJson: Record<string, unknown> = {};
      try {
        resJson = JSON.parse(bodyText);
      } catch {
        throw new TokenExchangeError('Malformed response from /trade/apitoken');
      }

      if (resJson.stat !== 'Ok' || !resJson.token || typeof resJson.token !== 'string') {
        throw new TokenExchangeError();
      }

      return resJson.token;
    } catch (err: unknown) {
      if (err instanceof TokenExchangeError) throw err;
      throw new TokenExchangeError();
    }
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }
}
