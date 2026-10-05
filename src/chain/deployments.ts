import { readFileSync } from 'node:fs';

export const CONTRACT_NAMES = ['config', 'registry', 'reputation', 'supplier_bond', 'group_buy', 'disputes'] as const;
export type ContractName = (typeof CONTRACT_NAMES)[number];

export interface Deployments {
  network: string;
  usdc: string;
  admin: string;
  contracts: Record<ContractName, { id: string; wasmHash: string }>;
}

/** Reads deployments/<network>.json produced by the contracts repo (`scripts/deploy.sh`). */
export function loadDeployments(file: string): Deployments {
  const d = JSON.parse(readFileSync(file, 'utf8')) as Deployments;
  for (const n of CONTRACT_NAMES) {
    if (!d.contracts?.[n]?.id) throw new Error(`deployments file ${file} is missing contract "${n}"`);
  }
  return d;
}

export const contractId = (d: Deployments, n: ContractName): string => d.contracts[n].id;

/** contract id -> logical name, for the sponsorship allow-list. */
export const contractNameMap = (d: Deployments): Map<string, ContractName> =>
  new Map(CONTRACT_NAMES.map((n) => [d.contracts[n].id, n]));
