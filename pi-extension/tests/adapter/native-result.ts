import type { NativeMcpResult } from '../../core/types.ts';

/** SOURCE-DERIVED host fixture, not a deployed registration/capture.
 * Pi 1.5 built-in extensions/mcp/tools.js convertMcpResult keeps the complete
 * CallToolResult minus _meta in host structuredContent. Model-facing content
 * is deliberately distinct: Core must never parse or use it as native data.
 * Tests may mutate the projected native payload after conversion (as a hook
 * could); malformed fixtures are not a claim that conversion accepts them.
 */
export function builtinMcpResult(native: NativeMcpResult): NativeMcpResult {
  const { _meta: ignored, ...scriptResult } = native;
  return {
    content: [{ type: 'text', text: 'Untrusted model-facing host presentation' }],
    details: { server: 'plannotator-inbox', tool: 'source-derived-fixture' },
    structuredContent: scriptResult,
    ...(native.isError ? { isError: true } : {}),
  };
}
