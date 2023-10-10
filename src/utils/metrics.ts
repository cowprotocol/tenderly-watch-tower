import client from "prom-client";

export function measureTime<T>(
  action: () => T,
  labels: string[],
  durationMetric: client.Histogram,
  totalRunsMetric: client.Counter,
  errorHandler?: (err: any) => T,
  errorMetric?: client.Counter
): T {
  const timer = durationMetric.labels(...labels).startTimer();
  let result: T;
  try {
    result = action();
  } catch (err) {
    if (errorHandler === undefined) {
      throw err;
    }

    if (errorMetric === undefined) {
      throw new Error("errorMetric must be defined if errorHandler is defined");
    }

    errorMetric.labels(...labels).inc();
    result = errorHandler(err);
  } finally {
    timer();
  }
  totalRunsMetric.labels(...labels).inc();
  return result;
}

export const blockHeight = new client.Gauge({
  name: "watch_tower_block_height",
  help: "Block height of the block watcher",
  labelNames: ["chain_id"],
});

export const reorgDepth = new client.Gauge({
  name: "watch_tower_reorg_depth",
  help: "Depth of the current reorg",
  labelNames: ["chain_id"],
});

export const blockTime = new client.Gauge({
  name: "watch_tower_block_time_seconds",
  help: "Time since last block",
  labelNames: ["chain_id"],
});

export const eventsProcessedTotal = new client.Counter({
  name: "watch_tower_events_processed_total",
  help: "Total number of events processed",
  labelNames: ["chain_id"],
});

export const reorgsTotal = new client.Counter({
  name: "watch_tower_reorg_total",
  help: "Total number of reorgs",
  labelNames: ["chain_id"],
});

export const newContractsTotal = new client.Counter({
  name: "watch_tower_new_contracts_total",
  help: "Total number of new contracts",
  labelNames: ["chain_id"],
});

export const singleOrdersTotal = new client.Counter({
  name: "watch_tower_single_orders_total",
  help: "Total number of single orders processed",
  labelNames: ["chain_id"],
});

export const merkleRootTotal = new client.Counter({
  name: "watch_tower_merkle_roots_total",
  help: "Total number of merkle roots processed",
  labelNames: ["chain_id"],
});

export const addContractRunsTotal = new client.Counter({
  name: "watch_tower_add_contract_runs_total",
  help: "Total number of add contract runs",
  labelNames: ["chain_id"],
});

export const addContractsErrorsTotal = new client.Counter({
  name: "watch_tower_add_contracts_errors_total",
  help: "Total number of add contracts errors",
  labelNames: ["chain_id", "function"],
});

export const addContractsRunDurationSeconds = new client.Histogram({
  name: "watch_tower_add_contracts_run_duration_seconds",
  help: "Duration of add contracts run",
  labelNames: ["chain_id"],
});

export const processBlockDurationSeconds = new client.Histogram({
  name: "watch_tower_process_block_duration_seconds",
  help: "Duration of process block",
  labelNames: ["chain_id"],
});

export const activeOwnersTotal = new client.Gauge({
  name: "watch_tower_active_owners_total",
  help: "Total number of owners with active orders",
  labelNames: ["chain_id"],
});

export const activeOrdersTotal = new client.Gauge({
  name: "watch_tower_active_orders_total",
  help: "Total number of active orders",
  labelNames: ["chain_id"],
});

export const orderBookDiscreteOrdersTotal = new client.Counter({
  name: "watch_tower_orderbook_discrete_orders_total",
  help: "Total number of discrete orders posted to the orderbook",
  labelNames: ["chain_id", "handler", "owner", "id"],
});

export const orderBookErrorsTotal = new client.Counter({
  name: "watch_tower_orderbook_errors_total",
  help: "Total number of errors when interacting with the orderbook",
  labelNames: ["chain_id", "handler", "owner", "id", "status", "error"],
});

export const pollingRunsTotal = new client.Counter({
  name: "watch_tower_polling_runs_total",
  help: "Total number of polling runs",
  labelNames: ["chain_id", "handler", "owner", "id"],
});

export const pollingOnChainChecksTotal = new client.Counter({
  name: "watch_tower_polling_onchain_checks_total",
  help: "Total number of on-chain hint checks",
  labelNames: ["chain_id", "handler", "owner", "id"],
});

export const pollingOnChainDurationSeconds = new client.Histogram({
  name: "watch_tower_polling_onchain_duration_seconds",
  help: "Duration of on-chain hint checks",
  labelNames: ["chain_id", "handler", "owner", "id"],
});

export const pollingOnChainInvalidInterfacesTotal = new client.Counter({
  name: "watch_tower_polling_onchain_invalid_interface_total",
  help: "Total number of invalid on-chain hint interface",
  labelNames: ["chain_id", "handler", "owner", "id"],
});

export const pollingOnChainEthersErrorsTotal = new client.Counter({
  name: "watch_tower_polling_onchain_ethers_errors_total",
  help: "Total number of ethers on-chain hint errors",
  labelNames: ["chain_id", "handler", "owner", "id"],
});

export const pollingUnexpectedErrorsTotal = new client.Counter({
  name: "watch_tower_polling_unexpected_errors_total",
  help: "Total number of unexpected polling errors",
  labelNames: ["chain_id", "handler", "owner", "id"],
});