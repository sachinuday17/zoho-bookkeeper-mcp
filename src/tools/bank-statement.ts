/**
 * MERGED INTO bank-reconciliation.ts
 *
 * All tools previously in this file have been consolidated into
 * src/tools/bank-reconciliation.ts which is the single source of truth
 * for all Banking module statement-feed operations.
 *
 * This file is intentionally empty to avoid duplicate tool registration.
 */

import type { FastMCP } from "fastmcp"

// No-op — tools are registered by registerBankReconciliationTools in bank-reconciliation.ts
export function registerBankStatementTools(_server: FastMCP): void {
  // intentionally empty
}
