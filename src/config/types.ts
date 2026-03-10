/**
 * TypeScript interfaces for YAML tool configuration
 * Matches structure defined in yaml/tools.yaml
 */

import type { Capabilities } from './index.js';

/**
 * Validation rules for parameters
 */
export interface YamlValidation {
  // String validations
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: 'uri' | 'email' | 'uuid';

  // Number validations
  readonly min?: number;
  readonly max?: number;
  readonly int?: boolean;
  readonly positive?: boolean;
  readonly negative?: boolean;

  // Array validations
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly nonempty?: boolean;
}

/**
 * Parameter definition in YAML
 */
export interface YamlParameter {
  readonly type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  readonly required?: boolean;
  readonly default?: unknown;
  readonly description?: string;
  readonly validation?: YamlValidation;

  // For array type
  readonly items?: YamlParameter;

  // For object type
  readonly properties?: Record<string, YamlParameter>;
}

/**
 * Tool definition in YAML
 */
export interface YamlToolConfig {
  readonly name: string;
  readonly category?: string;
  readonly capability?: keyof Capabilities;
  readonly description: string;

  // For tools with simple inline parameters
  readonly parameters?: Record<string, YamlParameter>;

  // For tools using existing Zod schemas
  readonly useZodSchema?: boolean;
  readonly zodSchemaRef?: string;

  // Description overrides for existing Zod schemas
  readonly schemaDescriptions?: Record<string, string>;

  // Configurable limits and settings
  readonly limits?: Record<string, string | number | boolean>;
}

/**
 * Root YAML configuration structure
 */
export interface YamlConfig {
  readonly version: string;
  readonly metadata: {
    readonly name: string;
    readonly description: string;
  };
  readonly tools: readonly YamlToolConfig[];
}

/**
 * MCP Tool definition (matches SDK)
 */
export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, unknown>;
    readonly required?: string[];
  };
}

/**
 * Loaded tool with additional metadata
 */
export interface LoadedTool extends McpTool {
  readonly category?: string;
  readonly capability?: keyof Capabilities;
  readonly useZodSchema?: boolean;
  readonly zodSchemaRef?: string;
}
