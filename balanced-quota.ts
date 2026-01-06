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
 * 
 * SPECIAL RULES:
 * - gemini-3-pro variants (high/low/preview) are grouped into 'gemini-3-pro'
 * - rev19-uic3-1p renamed to gemini-2.5-computer-use-preview-10-2025
 */
function normalizeModelName(modelId: string): string {
  // Special Rule: Rename rev19-uic3-1p
  if (modelId === 'rev19-uic3-1p') {
    return 'gemini-2.5-computer-use-preview-10-2025';
  }

  // Special Rule: Gemini 3 Pro shared pool
  // gemini-3-pro, gemini-3-pro-preview, gemini-3-pro-high, gemini-3-pro-low -> gemini-3-pro
  if (['gemini-3-pro', 'gemini-3-pro-preview', 'gemini-3-pro-high', 'gemini-3-pro-low'].includes(modelId)) {
    return 'gemini-3-pro';
  }

  // Special Rule: Gemini 3 Flash shared pool
  if (['gemini-3-flash', 'gemini-3-flash-preview'].includes(modelId)) {
    return 'gemini-3-flash';
  }

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
  // Get absolute path to quota-simple.ts (same directory as this file)
  const currentDir = new URL('.', import.meta.url).pathname;
  const quotaSimplePath = `${currentDir}quota-simple.ts`;

  const cmd = new Deno.Command('deno', {
    args: [
      'run',
      '--allow-net',
      '--allow-read',
      quotaSimplePath,
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
      const extracted = extractAntigravityQuotas(result.quota);
      allQuotas.push(...filterRedundantThinkingModels(extracted));
    } else if (result.provider === 'gemini-cli') {
      const extracted = extractGeminiCliQuotas(result.quota);
      allQuotas.push(...filterRedundantThinkingModels(extracted));
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
    // Unless it's the special Gemini 3 Pro group, then force 'gemini-3-pro'
    let fullModelName = quotas[0].modelId;
    if (normalizedName === 'gemini-3-pro') {
      fullModelName = 'gemini-3-pro';
    } else if (normalizedName === 'gemini-3-flash') {
      fullModelName = 'gemini-3-flash';
    } else if (quotas[0].modelId === 'rev19-uic3-1p') {
      // Special Rename Rule
      fullModelName = 'gemini-2.5-computer-use-preview-10-2025';
    }

    balancedQuotas[fullModelName] = average;
  }

  // Apply post-processing rules
  return applyVertexAiGrouping(balancedQuotas);
}

/**
 * Filter out redundant thinking models from a single provider's quota list
 * If a model has a "-thinking" variant with the exact same quota, keep only the non-thinking one.
 */
function filterRedundantThinkingModels(quotas: ModelQuota[]): ModelQuota[] {
  const quotaMap = new Map<string, number>();
  for (const q of quotas) {
    quotaMap.set(q.modelId, q.remainingFraction);
  }

  return quotas.filter(q => {
    // Check if this is a thinking model
    if (q.modelId.endsWith('-thinking')) {
      const baseKey = q.modelId.replace(/-thinking$/, '');
      
      // Check if base model exists in this provider
      if (quotaMap.has(baseKey)) {
        const baseQuota = quotaMap.get(baseKey)!;
        
        // If quotas are effectively equal, remove this thinking variant
        if (Math.abs(q.remainingFraction - baseQuota) < 1e-9) {
          return false;
        }
      }
    }
    return true;
  });
}

/**
 * Apply Vertex AI grouping logic
 * 1. Combine matching claude- models into gemini-claude-models
 * 2. If gemini-claude-models matches gpt-oss-120b- models, combine all into vertex-ai
 */
function applyVertexAiGrouping(quotas: Record<string, number>): Record<string, number> {
  const result = { ...quotas };
  
  // 1. Identify 'gemini-claude-' models (assuming this means keys starting with 'claude-' or 'gemini-claude-')
  const claudeKeys = Object.keys(result).filter(k => 
    k.startsWith('claude-') || k.startsWith('gemini-claude-')
  );
  
  // Check if they have exact limits (all values equal)
  let claudeValue: number | null = null;
  let claudeConsistent = false;
  
  if (claudeKeys.length > 0) {
    const values = claudeKeys.map(k => result[k]);
    // Use a small epsilon for float comparison, or strict equality since they often come from same source
    const firstVal = values[0];
    claudeConsistent = values.every(v => Math.abs(v - firstVal) < 1e-9);
    
    if (claudeConsistent) {
      claudeValue = firstVal;
    }
  }

  // 2. Identify 'gpt-oss-120b-*' models
  const gptKeys = Object.keys(result).filter(k => k.startsWith('gpt-oss-120b-'));
  let gptValue: number | null = null;
  let gptConsistent = false;

  if (gptKeys.length > 0) {
    const values = gptKeys.map(k => result[k]);
    const firstVal = values[0];
    gptConsistent = values.every(v => Math.abs(v - firstVal) < 1e-9);

    if (gptConsistent) {
      gptValue = firstVal;
    }
  }

  // Logic Application
  if (claudeConsistent && claudeValue !== null) {
    // Check if we can combine with GPT OSS
    if (gptConsistent && gptValue !== null && Math.abs(claudeValue - gptValue) < 1e-9) {
      // Combine EVERYTHING into 'vertex-ai'
      [...claudeKeys, ...gptKeys].forEach(k => delete result[k]);
      result['vertex-ai'] = claudeValue;
    } else {
      // Combine only Claude models into 'gemini-claude-models'
      claudeKeys.forEach(k => delete result[k]);
      result['gemini-claude-models'] = claudeValue;
    }
  }

  return result;
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
