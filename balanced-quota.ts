#!/usr/bin/env -S deno run --allow-net --allow-read --allow-run

/**
 * Balanced Quota Calculator for CLIProxyAPI
 *
 * Usage: deno run balanced-quota.ts <CLIProxyAPI_MANAGEMENT_KEY> [BASE_URL]
 *
 * This script calls quota-simple.ts and combines model quotas across providers,
 * calculating the mid/average value for models with the same name.
 */

interface QuotaResult {
  provider: string;
  authIndex: string;
  label: string;
  status: 'success' | 'error';
  quota?: any;
  error?: string;
  timestamp: string;
}

interface QuotaSimpleOutput {
  timestamp: string;
  baseUrl: string;
  results: QuotaResult[];
}

interface ModelQuota {
  modelId: string;
  remainingFraction: number;
  provider: string;
}

/**
 * Normalize model name for matching across providers
 * Removes common provider prefixes (gemini-, claude-, gpt-, qwen-) only
 * Keeps variant suffixes (like -thinking, -preview, -lite) to distinguish different model variants
 */
function normalizeModelName(modelId: string): string {
  // Remove common provider prefixes only (keep everything else)
  let normalized = modelId;

  // Remove provider prefixes
  normalized = normalized.replace(/^gemini-/, '');
  normalized = normalized.replace(/^claude-/, '');
  normalized = normalized.replace(/^gpt-/, '');
  normalized = normalized.replace(/^qwen-/, '');

  return normalized;
}

/**
 * Extract quotas from antigravity provider response
 */
function extractAntigravityQuotas(quota: any): ModelQuota[] {
  if (!quota || typeof quota !== 'object') {
    return [];
  }

  const quotas: ModelQuota[] = [];

  for (const [modelId, modelData] of Object.entries(quota as Record<string, any>)) {
    if (modelData && typeof modelData === 'object' && 'remainingFraction' in modelData) {
      quotas.push({
        modelId,
        remainingFraction: modelData.remainingFraction as number,
        provider: 'antigravity'
      });
    }
  }

  return quotas;
}

/**
 * Extract quotas from gemini-cli provider response
 * Note: gemini-cli quota format uses buckets with modelId field
 */
function extractGeminiCliQuotas(quota: any): ModelQuota[] {
  if (!quota || !quota.buckets || !Array.isArray(quota.buckets)) {
    return [];
  }

  const quotas: ModelQuota[] = [];

  // gemini-cli quota structure: buckets with model information
  for (const bucket of quota.buckets) {
    if (bucket && typeof bucket === 'object') {
      // Try to extract model name and remaining fraction
      const modelName = bucket.modelId || bucket.model_name || bucket.model;
      const remainingFraction = bucket.remainingFraction || bucket.remaining_fraction || bucket.fraction;

      if (modelName && typeof remainingFraction === 'number') {
        quotas.push({
          modelId: modelName,
          remainingFraction,
          provider: 'gemini-cli'
        });
      }
    }
  }

  return quotas;
}

/**
 * Call quota-simple.ts and parse the output
 */
async function getQuotaSimpleOutput(apiKey: string, baseUrl: string): Promise<QuotaSimpleOutput> {
  const cmd = new Deno.Command('deno', {
    args: [
      'run',
      '--allow-net',
      '--allow-read',
      'quota-simple.ts',
      apiKey,
      baseUrl
    ],
    stdout: 'piped',
    stderr: 'piped'
  });

  const { code, stdout, stderr } = await cmd.output();

  // quota-simple.ts may exit with non-zero code even if some quotas were fetched successfully
  // We should still try to parse the output from stdout (JSON always goes there)
  const outputText = new TextDecoder().decode(stdout);
  const errorText = new TextDecoder().decode(stderr);

  // Debug: log stderr for troubleshooting
  if (errorText.trim()) {
    console.error(`quota-simple.ts stderr: ${errorText}`);
  }

  if (!outputText.trim()) {
    throw new Error(`quota-simple.ts produced no output (code ${code})`);
  }

  try {
    return JSON.parse(outputText) as QuotaSimpleOutput;
  } catch (err) {
    throw new Error(`Failed to parse quota-simple.ts output: ${err}\nOutput was: ${outputText}`);
  }
}

/**
 * Calculate balanced quotas across providers
 */
function calculateBalancedQuotas(results: QuotaResult[]): Record<string, number> {
  const allQuotas: ModelQuota[] = [];

  // Extract quotas from all successful results
  for (const result of results) {
    if (result.status !== 'success' || !result.quota) {
      continue;
    }

    if (result.provider === 'antigravity') {
      const quotas = extractAntigravityQuotas(result.quota);
      allQuotas.push(...quotas);
    } else if (result.provider === 'gemini-cli') {
      const quotas = extractGeminiCliQuotas(result.quota);
      allQuotas.push(...quotas);
    }
  }

  // Group quotas by normalized model name
  const groupedQuotas = new Map<string, ModelQuota[]>();

  for (const quota of allQuotas) {
    const normalizedName = normalizeModelName(quota.modelId);

    if (!groupedQuotas.has(normalizedName)) {
      groupedQuotas.set(normalizedName, []);
    }
    groupedQuotas.get(normalizedName)!.push(quota);
  }

  // Calculate average quota for each group
  const balancedQuotas: Record<string, number> = {};

  for (const [normalizedName, quotas] of groupedQuotas.entries()) {
    if (quotas.length === 0) {
      continue;
    }

    const total = quotas.reduce((sum, q) => sum + q.remainingFraction, 0);
    const average = total / quotas.length;

    // Use the full model name from the first quota for the output
    const fullModelName = quotas[0].modelId;
    balancedQuotas[fullModelName] = average;
  }

  return balancedQuotas;
}

/**
 * Main function
 */
async function main() {
  const args = Deno.args;

  if (args.length < 1) {
    console.error('Usage: deno run balanced-quota.ts <CLIProxyAPI_MANAGEMENT_KEY> [BASE_URL]');
    console.error('');
    console.error('Example:');
    console.error('  deno run balanced-quota.ts sk-1234');
    console.error('  deno run balanced-quota.ts sk-1234 http://127.0.0.1:8317/v0/management');
    Deno.exit(1);
  }

  const apiKey = args[0];
  const baseUrl = args[1] || 'http://127.0.0.1:8317/v0/management';

  try {
    // Get quota data from quota-simple.ts
    const quotaData = await getQuotaSimpleOutput(apiKey, baseUrl);

    // Calculate balanced quotas
    const balancedQuotas = calculateBalancedQuotas(quotaData.results);

    // Output as JSON
    console.log(JSON.stringify(balancedQuotas, null, 2));
  } catch (err: any) {
    console.error('Error:', err.message);
    Deno.exit(1);
  }
}

// Run
main();
