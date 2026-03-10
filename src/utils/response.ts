/**
 * MCP Response Formatters - 70/20/10 Pattern
 * 
 * All tool responses should follow this structure:
 * - 70% Summary: Key insights, status, metrics
 * - 20% Data: Structured results (lists, tables)
 * - 10% Next Steps: Actionable follow-up commands
 */

/** Default maximum items to display in list formatting */
export const DEFAULT_MAX_ITEMS = 20 as const;

/** Maximum snippet length before truncation in URL aggregator output */
export const MAX_SNIPPET_LENGTH = 200 as const;

/** Duration thresholds in milliseconds */
const SECONDS_MS = 1_000 as const;
const MINUTES_MS = 60_000 as const;

// ============================================================================
// Success Response Formatter
// ============================================================================

export interface SuccessOptions {
  /** Title/header for the response */
  readonly title: string;
  /** Summary section (70% of content) */
  readonly summary: string;
  /** Optional data section (20% of content) */
  readonly data?: string;
  /** Optional next steps (10% of content) */
  readonly nextSteps?: string[];
  /** Optional metadata footer */
  readonly metadata?: Record<string, string | number>;
}

/**
 * Format a successful response using 70/20/10 pattern
 */
export function formatSuccess(opts: SuccessOptions): string {
  const parts: string[] = [];

  // Title
  parts.push(`✓ ${opts.title}`);
  parts.push('');

  // Summary (70%)
  parts.push(opts.summary);

  // Data section (20%)
  if (opts.data) {
    parts.push('');
    parts.push('---');
    parts.push(opts.data);
  }

  // Next steps (10%)
  if (opts.nextSteps?.length) {
    parts.push('');
    parts.push('---');
    parts.push('**Next Steps:**');
    opts.nextSteps.forEach(step => parts.push(`→ ${step}`));
  }

  // Metadata footer
  if (opts.metadata && Object.keys(opts.metadata).length > 0) {
    parts.push('');
    parts.push('---');
    const metaStr = Object.entries(opts.metadata)
      .map(([k, v]) => `${k}: ${v}`)
      .join(' | ');
    parts.push(`*${metaStr}*`);
  }

  return parts.join('\n');
}

// ============================================================================
// Error Response Formatter
// ============================================================================

export interface ErrorOptions {
  /** Error code (e.g., RATE_LIMITED, TIMEOUT) */
  readonly code: string;
  /** Human-readable error message */
  readonly message: string;
  /** Is this error retryable? */
  readonly retryable?: boolean;
  /** How to fix the error */
  readonly howToFix?: string[];
  /** Alternative actions */
  readonly alternatives?: string[];
  /** Tool name for context */
  readonly toolName?: string;
}

/**
 * Format an error response with recovery guidance
 * Designed to keep agents moving — every error includes actionable alternatives
 */
export function formatError(opts: ErrorOptions): string {
  const parts: string[] = [];

  // Error header
  const prefix = opts.toolName ? `[${opts.toolName}] ` : '';
  parts.push(`❌ ${prefix}${opts.code}: ${opts.message}`);

  // Retryable hint — be specific about what to do while waiting
  if (opts.retryable) {
    parts.push('');
    parts.push('*This error is retryable. Wait a moment and try again — but use the alternatives below in the meantime so research continues.*');
  }

  // How to fix
  if (opts.howToFix?.length) {
    parts.push('');
    parts.push('**How to Fix:**');
    opts.howToFix.forEach((step, i) => parts.push(`${i + 1}. ${step}`));
  }

  // Alternatives — directive, not optional
  if (opts.alternatives?.length) {
    parts.push('');
    parts.push('**DO THIS INSTEAD (don\'t stop researching):**');
    opts.alternatives.forEach((alt, i) => parts.push(`${i + 1}. ${alt}`));
  }

  // Continuation footer — push agents to keep going
  if (opts.alternatives?.length) {
    parts.push('');
    parts.push('> This tool failed but your research should NOT stop. Use the alternatives above to continue gathering information from other sources.');
  }

  return parts.join('\n');
}

// ============================================================================
// Batch Header Formatter
// ============================================================================

export interface BatchHeaderOptions {
  /** Batch operation title */
  readonly title: string;
  /** Total items attempted */
  readonly totalItems: number;
  /** Successfully processed count */
  readonly successful: number;
  /** Failed count */
  readonly failed: number;
  /** Optional tokens per item */
  readonly tokensPerItem?: number;
  /** Optional batch count */
  readonly batches?: number;
  /** Extra stats to include */
  readonly extras?: Record<string, string | number>;
}

/**
 * Format a batch operation header with stats
 */
export function formatBatchHeader(opts: BatchHeaderOptions): string {
  const parts: string[] = [];

  // Title with emoji based on success rate
  const successRate = opts.totalItems > 0 ? opts.successful / opts.totalItems : 0;
  const emoji = successRate === 1 ? '✓' : successRate >= 0.5 ? '⚠️' : '❌';
  parts.push(`${emoji} ${opts.title}`);
  parts.push('');

  // Stats
  parts.push(`• Total: ${opts.totalItems}`);
  parts.push(`• Successful: ${opts.successful}`);
  if (opts.failed > 0) {
    parts.push(`• Failed: ${opts.failed}`);
  }
  if (opts.tokensPerItem) {
    parts.push(`• Tokens/item: ~${opts.tokensPerItem.toLocaleString()}`);
  }
  if (opts.batches) {
    parts.push(`• Batches: ${opts.batches}`);
  }

  // Extra stats
  if (opts.extras) {
    Object.entries(opts.extras).forEach(([key, val]) => {
      parts.push(`• ${key}: ${val}`);
    });
  }

  return parts.join('\n');
}

// ============================================================================
// List Formatter
// ============================================================================

export interface ListItem {
  /** Item title/name */
  readonly title: string;
  /** Optional description */
  readonly description?: string;
  /** Optional metadata */
  readonly meta?: string;
  /** Optional URL */
  readonly url?: string;
}

/**
 * Format a numbered list with optional metadata
 */
export function formatList(items: ListItem[], options?: { maxItems?: number; numbered?: boolean }): string {
  const max = options?.maxItems ?? DEFAULT_MAX_ITEMS;
  const numbered = options?.numbered ?? true;
  const toShow = items.slice(0, max);
  const remaining = items.length - max;

  const lines = toShow.map((item, i) => {
    const prefix = numbered ? `${i + 1}. ` : '• ';
    let line = `${prefix}**${item.title}**`;
    if (item.meta) {
      line += ` (${item.meta})`;
    }
    if (item.description) {
      line += `\n   ${item.description}`;
    }
    if (item.url) {
      line += `\n   ${item.url}`;
    }
    return line;
  });

  if (remaining > 0) {
    lines.push(`\n*...and ${remaining} more*`);
  }

  return lines.join('\n');
}

// ============================================================================
// Duration Formatter
// ============================================================================

/**
 * Format duration in human-readable form
 */
export function formatDuration(ms: number): string {
  if (ms < SECONDS_MS) return `${ms}ms`;
  if (ms < MINUTES_MS) return `${(ms / SECONDS_MS).toFixed(1)}s`;
  return `${(ms / MINUTES_MS).toFixed(1)}m`;
}

// ============================================================================
// Text Truncation
// ============================================================================

/**
 * Truncate text to max length with ellipsis
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}
