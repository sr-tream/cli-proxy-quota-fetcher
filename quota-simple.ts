#!/usr/bin/env -S deno run --allow-net --allow-read

/**
 * Quota Fetcher for CLIProxyAPI
 *
 * Usage: deno run quota-simple.ts <CLIProxyAPI_MANAGEMENT_KEY>
 *
 * This script fetches quota information from all configured auth providers
 * and returns a consolidated JSON output.
 */

// ============================================================================
// CONSTANTS (from https://raw.githubusercontent.com/router-for-me/Cli-Proxy-API-Management-Center/refs/heads/main/src/utils/quota/constants.ts)
// ============================================================================

const ANTIGRAVITY_QUOTA_URLS = [
  'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels',
  'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels'
];

const ANTIGRAVITY_REQUEST_HEADERS = {
  'Authorization': 'Bearer $TOKEN$',
  'Content-Type': 'application/json',
  'User-Agent': 'antigravity/1.11.5 windows/amd64'
};

const GEMINI_CLI_QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota';

const GEMINI_CLI_REQUEST_HEADERS = {
  'Authorization': 'Bearer $TOKEN$',
  'Content-Type': 'application/json'
};

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

const CODEX_REQUEST_HEADERS = {
  'Authorization': 'Bearer $TOKEN$',
  'Content-Type': 'application/json',
  'User-Agent': 'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal'
};

// ============================================================================
// TYPES
// ============================================================================

interface AuthFile {
  id: string;
  auth_index: string;
  provider: string;
  label?: string;
  disabled: boolean;
  email?: string;
  account?: string;
  attributes?: Record<string, string>;
}

interface QuotaResult {
  provider: string;
  authIndex: string;
  label: string;
  status: 'success' | 'error';
  quota?: any;
  error?: string;
  timestamp: string;
}

// ============================================================================
// CLIProxyAPI Client
// ============================================================================

class CLIProxyAPIClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  private async request<T>(method: string, path: string, body?: any): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json'
    };

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    return response.json();
  }

  private async apiCall(req: any): Promise<any> {
    const result = await this.request<any>('POST', '/api-call', req);

    // The API returns: { status_code, header, body }
    // Transform to match expected format
    return {
      statusCode: result.status_code,
      header: result.header,
      body: result.body
    };
  }

  async getAuthFiles(): Promise<{ files: AuthFile[] }> {
    return this.request('GET', '/auth-files');
  }
}

// ============================================================================
// Quota Fetcher
// ============================================================================

class QuotaFetcher {
  private client: CLIProxyAPIClient;

  constructor(client: CLIProxyAPIClient) {
    this.client = client;
  }

  async fetchAllQuotas(): Promise<QuotaResult[]> {
    const authFiles = await this.client.getAuthFiles();
    const results: QuotaResult[] = [];

    // Group auth files by provider
    const groupedFiles = this.groupByProvider(authFiles.files);

    // Fetch antigravity quota
    const antigravityFiles = groupedFiles.get('antigravity') || [];
    for (const file of antigravityFiles) {
      if (file.disabled) continue;
      const result = await this.fetchAntigravityQuota(file);
      results.push(result);
    }

    // Fetch gemini-cli quota
    const geminiFiles = groupedFiles.get('gemini-cli') || [];
    for (const file of geminiFiles) {
      if (file.disabled) continue;
      const result = await this.fetchGeminiCliQuota(file);
      results.push(result);
    }

    // Fetch codex quota
    const codexFiles = groupedFiles.get('codex') || [];
    for (const file of codexFiles) {
      if (file.disabled) continue;
      const result = await this.fetchCodexQuota(file);
      results.push(result);
    }

    return results;
  }

  private groupByProvider(files: AuthFile[]): Map<string, AuthFile[]> {
    const grouped = new Map<string, AuthFile[]>();
    for (const file of files) {
      const provider = file.provider;
      if (!grouped.has(provider)) {
        grouped.set(provider, []);
      }
      grouped.get(provider)!.push(file);
    }
    return grouped;
  }

  private async fetchAntigravityQuota(file: AuthFile): Promise<QuotaResult> {
    const lastError: string[] = [];

    for (const url of ANTIGRAVITY_QUOTA_URLS) {
      try {
        const response = await this.client.apiCall({
          authIndex: file.auth_index,
          method: 'POST',
          url,
          header: { ...ANTIGRAVITY_REQUEST_HEADERS },
          data: '{}'
        });

        if (response.statusCode >= 200 && response.statusCode < 300) {
          const body = typeof response.body === 'string'
            ? JSON.parse(response.body)
            : response.body;
          const models = body?.models;

          return {
            provider: 'antigravity',
            authIndex: file.auth_index,
            label: file.label || file.email || file.account || file.id,
            status: 'success',
            quota: this.extractAntigravityQuota(models),
            timestamp: new Date().toISOString()
          };
        } else {
          lastError.push(`HTTP ${response.statusCode}`);
          continue;
        }
      } catch (err: any) {
        lastError.push(err.message || String(err));
        continue;
      }
    }

    return {
      provider: 'antigravity',
      authIndex: file.auth_index,
      label: file.label || file.email || file.account || file.id,
      status: 'error',
      error: lastError.join(', ') || 'Failed to fetch quota',
      timestamp: new Date().toISOString()
    };
  }

  private extractAntigravityQuota(models: any): any {
    if (!models || typeof models !== 'object') {
      return {};
    }

    const quota: any = {};
    for (const [modelId, model] of Object.entries(models as Record<string, any>)) {
      if (model && model.quotaInfo) {
        quota[modelId] = {
          displayName: model.displayName,
          remainingFraction: model.quotaInfo.remainingFraction,
          resetTime: model.quotaInfo.resetTime
        };
      }
    }

    return quota;
  }

  private async fetchGeminiCliQuota(file: AuthFile): Promise<QuotaResult> {
    const projectId = this.extractProjectId(file);

    try {
      const response = await this.client.apiCall({
        authIndex: file.auth_index,
        method: 'POST',
        url: GEMINI_CLI_QUOTA_URL,
        header: { ...GEMINI_CLI_REQUEST_HEADERS },
        data: JSON.stringify({ project: projectId })
      });

      if (response.statusCode >= 200 && response.statusCode < 300) {
        const body = typeof response.body === 'string'
          ? JSON.parse(response.body)
          : response.body;
        const buckets = body?.buckets || [];

        return {
          provider: 'gemini-cli',
          authIndex: file.auth_index,
          label: file.label || file.email || file.account || file.id,
          status: 'success',
          quota: { buckets },
          timestamp: new Date().toISOString()
        };
      } else {
        return {
          provider: 'gemini-cli',
          authIndex: file.auth_index,
          label: file.label || file.email || file.account || file.id,
          status: 'error',
          error: `HTTP ${response.statusCode}`,
          timestamp: new Date().toISOString()
        };
      }
    } catch (err: any) {
      return {
        provider: 'gemini-cli',
        authIndex: file.auth_index,
        label: file.label || file.email || file.account || file.id,
        status: 'error',
        error: err.message || String(err),
        timestamp: new Date().toISOString()
      };
    }
  }

  private extractProjectId(file: AuthFile): string {
    // Try to extract from email account info
    if (file.email && file.email.includes('(')) {
      const match = file.email.match(/\(([^)]+)\)/);
      if (match && match[1]) {
        return match[1];
      }
    }
    if (file.account && file.account.includes('prefab-setting')) {
      const parts = file.account.split('-');
      if (parts.length >= 2) {
        return parts.slice(1).join('-');
      }
    }
    return 'default-project';
  }

  private async fetchCodexQuota(file: AuthFile): Promise<QuotaResult> {
    const accountId = this.extractCodexAccountId(file);

    if (!accountId) {
      return {
        provider: 'codex',
        authIndex: file.auth_index,
        label: file.label || file.email || file.account || file.id,
        status: 'error',
        error: 'Missing account ID',
        timestamp: new Date().toISOString()
      };
    }

    try {
      const response = await this.client.apiCall({
        authIndex: file.auth_index,
        method: 'GET',
        url: CODEX_USAGE_URL,
        header: {
          ...CODEX_REQUEST_HEADERS,
          'Chatgpt-Account-Id': accountId
        }
      });

      if (response.statusCode >= 200 && response.statusCode < 300) {
        const body = typeof response.body === 'string'
          ? JSON.parse(response.body)
          : response.body;

        return {
          provider: 'codex',
          authIndex: file.auth_index,
          label: file.label || file.email || file.account || file.id,
          status: 'success',
          quota: body,
          timestamp: new Date().toISOString()
        };
      } else {
        return {
          provider: 'codex',
          authIndex: file.auth_index,
          label: file.label || file.email || file.account || file.id,
          status: 'error',
          error: `HTTP ${response.statusCode}`,
          timestamp: new Date().toISOString()
        };
      }
    } catch (err: any) {
      return {
        provider: 'codex',
        authIndex: file.auth_index,
        label: file.label || file.email || file.account || file.id,
        status: 'error',
        error: err.message || String(err),
        timestamp: new Date().toISOString()
      };
    }
  }

  private extractCodexAccountId(file: AuthFile): string | null {
    // Try to get from attributes first
    if (file.attributes && file.attributes['chatgpt_account_id']) {
      return file.attributes['chatgpt_account_id'];
    }
    if (file.attributes && file.attributes['account_id']) {
      return file.attributes['account_id'];
    }
    return null;
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const args = Deno.args;
  let quietMode = false;
  let apiKey = '';
  let baseUrl = 'http://127.0.0.1:8317/v0/management';
  let argIndex = 0;

  // Parse arguments
  if (args.length === 0) {
    console.error('Usage: deno run quota-simple.ts [-q] <CLIProxyAPI_MANAGEMENT_KEY> [BASE_URL]');
    console.error('');
    console.error('Options:');
    console.error('  -q    Quiet mode - suppress non-JSON output (only JSON to stdout)');
    console.error('');
    console.error('Example:');
    console.error('  deno run quota-simple.ts sk-1234');
    console.error('  deno run quota-simple.ts -q sk-1234');
    console.error('  deno run quota-simple.ts sk-1234 http://127.0.0.1:8317/v0/management');
    Deno.exit(1);
  }

  // Parse -q flag
  if (args[0] === '-q') {
    quietMode = true;
    argIndex = 1;
  }

  apiKey = args[argIndex];
  baseUrl = args[argIndex + 1] || baseUrl;

  if (!quietMode) {
    console.error(`Connecting to CLIProxyAPI at ${baseUrl}...`);
  }

  const client = new CLIProxyAPIClient(baseUrl, apiKey);
  const fetcher = new QuotaFetcher(client);

  try {
    const results = await fetcher.fetchAllQuotas();

    // Output as JSON to stdout (always)
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      baseUrl,
      results
    }, null, 2));

    // Summary to stderr (unless quiet mode)
    if (!quietMode) {
      const successCount = results.filter(r => r.status === 'success').length;
      const errorCount = results.filter(r => r.status === 'error').length;
      console.error(`\n✓ Success: ${successCount}, ✗ Errors: ${errorCount}`);
    }

    if (errorCount > 0) {
      Deno.exit(1);
    }
  } catch (err: any) {
    if (!quietMode) {
      console.error('Error:', err.message);
    }
    Deno.exit(1);
  }
}

// Run
main();
