// Single-source seam for Extractor config on the CLI + MCP (src/) side.
// Canonical resolver lives in hooks/lib/extractor-config.ts. src/ re-exports it
// so Curated LoA does not parse config a second time.
export {
  ExtractorConfigError,
  defaultExtractorConfigPath,
  requireAutomaticExtractor,
  requireCuratedExtractor,
  resolveExtractorConfig,
  resolveHarnessConfig,
} from '../../hooks/lib/extractor-config.js';
export type {
  AutomaticExtractorConfig,
  AutomaticExtractorId,
  CuratedExtractorConfig,
  CuratedExtractorId,
  ExtractorStep,
  PathResult,
  ResolveExtractorConfigOptions,
  ResolvedExtractorConfig,
  HarnessList,
  HarnessListResult,
  HarnessStep,
  LocalQueryMode,
  NamedHarnessId,
  ResolvedHarnessConfig,
} from '../../hooks/lib/extractor-config.js';
