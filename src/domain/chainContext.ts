import {
  RunSingleOptions,
  Registry,
  ReplayPlan,
  ConditionalOrderCreatedEvent,
  Multicall3,
  ComposableCoW,
  Multicall3__factory,
  RegistryBlock,
  blockToRegistryBlock,
} from "../types";
import {
  SupportedChainId,
  OrderBookApi,
  ApiBaseUrls,
} from "@cowprotocol/cow-sdk";
import { addContract } from "./addContract";
import { checkForAndPlaceOrder } from "./checkForAndPlaceOrder";
import { EventFilter, providers } from "ethers";
import {
  composableCowContract,
  DBService,
  getLogger,
  isRunningInKubernetesPod,
} from "../utils";
import {
  blockHeight,
  blockProducingRate,
  eventsProcessedTotal,
  processBlockDurationSeconds,
  reorgDepth,
  reorgsTotal,
} from "../utils/metrics";
import { hexZeroPad } from "ethers/lib/utils";
import { FilterPolicy } from "../utils/filterPolicy";

const WATCHDOG_FREQUENCY = 5 * 1000; // 5 seconds

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const FILTER_FREQUENCY_SECS = 60 * 60; // 1 hour

export const SDK_BACKOFF_NUM_OF_ATTEMPTS = 5;

enum ChainSync {
  /** The chain is currently in the warm-up phase, synchronising from contract genesis or lastBlockProcessed */
  SYNCING = "SYNCING",
  /** The chain is in sync with the latest block */
  IN_SYNC = "IN_SYNC",
  /** The chain is in an unknown state based on duration of time since a block was processed */
  UNKNOWN = "UNKNOWN",
}

type Chains = { [chainId: number]: ChainContext };

export interface ChainStatus {
  sync: ChainSync;
  chainId: SupportedChainId;
  lastProcessedBlock: RegistryBlock | null;
}

export interface ChainHealth extends ChainStatus {
  isHealthy: boolean;
}

export interface ChainWatcherHealth {
  overallHealth: boolean;
  chains: {
    [chainId: number]: ChainHealth;
  };
}

export interface FilterPolicyConfig {
  baseUrl: string;
  // authToken: string; // TODO: Implement authToken
}

/**
 * The chain context handles watching a single chain for new conditional orders
 * and executing them.
 */
export class ChainContext {
  readonly deploymentBlock: number;
  readonly pageSize: number;
  readonly dryRun: boolean;
  readonly watchdogTimeout: number;
  readonly addresses?: string[];
  readonly orderBookApiBaseUrls?: ApiBaseUrls;
  private sync: ChainSync = ChainSync.SYNCING;
  static chains: Chains = {};

  provider: providers.Provider;
  chainId: SupportedChainId;
  registry: Registry;
  orderBook: OrderBookApi;
  filterPolicy: FilterPolicy | undefined;
  contract: ComposableCoW;
  multicall: Multicall3;

  protected constructor(
    options: RunSingleOptions,
    provider: providers.Provider,
    chainId: SupportedChainId,
    registry: Registry
  ) {
    const {
      deploymentBlock,
      pageSize,
      dryRun,
      watchdogTimeout,
      owners,
      orderBookApi,
      filterPolicyConfig,
    } = options;
    this.deploymentBlock = deploymentBlock;
    this.pageSize = pageSize;
    this.dryRun = dryRun;
    this.watchdogTimeout = watchdogTimeout;
    this.addresses = owners;

    this.provider = provider;
    this.chainId = chainId;
    this.registry = registry;

    this.orderBookApiBaseUrls = orderBookApi
      ? ({
          [this.chainId]: orderBookApi,
        } as ApiBaseUrls) // FIXME: do not do this casting once this is fixed https://github.com/cowprotocol/cow-sdk/issues/176
      : undefined;

    this.orderBook = new OrderBookApi({
      chainId,
      baseUrls: this.orderBookApiBaseUrls,
      backoffOpts: {
        numOfAttempts: SDK_BACKOFF_NUM_OF_ATTEMPTS,
      },
    });

    this.filterPolicy = filterPolicyConfig
      ? new FilterPolicy({
          configBaseUrl: filterPolicyConfig,
          // configAuthToken: filterPolicyConfigAuthToken, // TODO: Implement authToken
        })
      : undefined;
    this.contract = composableCowContract(this.provider, this.chainId);
    this.multicall = Multicall3__factory.connect(MULTICALL3, this.provider);
  }

  /**
   * Initialize a chain context.
   *
   * @param options as parsed by commander from the command line arguments.
   * @param storage the db singleton that provides persistence.
   * @returns A chain context that is monitoring for orders on the chain.
   */
  public static async init(
    options: RunSingleOptions,
    storage: DBService
  ): Promise<ChainContext> {
    const { rpc, deploymentBlock } = options;

    const provider = new providers.WebSocketProvider(rpc);
    const chainId = (await provider.getNetwork()).chainId;

    const registry = await Registry.load(
      storage,
      chainId.toString(),
      deploymentBlock
    );

    // Save the context to the static map to be used by the API
    const context = new ChainContext(options, provider, chainId, registry);
    ChainContext.chains[chainId] = context;

    return context;
  }

  /**
   * Warm up the chain watcher by fetching the latest block number and
   * checking if the chain is in sync.
   * @param oneShot if true, only warm up the chain watcher and return
   * @returns the run promises for what needs to be watched
   */
  public async warmUp(oneShot?: boolean) {
    const { provider, chainId } = this;
    const log = getLogger("chainContext:warmUp", chainId.toString());
    const { lastProcessedBlock } = this.registry;
    const { pageSize } = this;

    // Set the block height metric
    blockHeight.labels(chainId.toString()).set(lastProcessedBlock?.number ?? 0);

    // Start watching from (not including) the last processed block (if any)
    let fromBlock = lastProcessedBlock
      ? lastProcessedBlock.number + 1
      : this.deploymentBlock;
    let currentBlock = await provider.getBlock("latest");

    let printSyncInfo = true; // Print sync info only once
    let plan: ReplayPlan = {};
    let toBlock: "latest" | number = 0;
    do {
      do {
        toBlock = !pageSize ? "latest" : fromBlock + (pageSize - 1);
        if (typeof toBlock === "number" && toBlock > currentBlock.number) {
          // refresh the current block
          currentBlock = await provider.getBlock("latest");
          toBlock =
            toBlock > currentBlock.number ? currentBlock.number : toBlock;

          // This happens when the watch-tower has restarted and the last processed block is
          // the current block. Therefore the `fromBlock` is the current block + 1, which is
          // greater than the current block number. In this case, we are in sync.
          if (fromBlock > currentBlock.number) {
            this.sync = ChainSync.IN_SYNC;
            break;
          }

          log.debug(
            `Reaching tip of chain, current block number: ${currentBlock.number}`
          );
        }

        if (printSyncInfo && typeof toBlock === "number") {
          printSyncInfo = false;
          log.info(
            `🔄 Start sync with from block ${fromBlock} to ${toBlock}. Pending ${
              toBlock - fromBlock
            } blocks (~${Math.ceil((toBlock - fromBlock) / pageSize)} pages)`
          );
        }

        log.debug(
          `Processing events from block ${fromBlock} to block ${toBlock}`
        );

        const events = await pollContractForEvents(fromBlock, toBlock, this);

        if (events.length > 0) {
          log.debug(`Found ${events.length} events`);
        }

        // process the events
        for (const event of events) {
          if (plan[event.blockNumber] === undefined) {
            plan[event.blockNumber] = new Set();
          }

          plan[event.blockNumber].add(event);
        }

        // only possible string value for toBlock is 'latest'
        if (typeof toBlock === "number") {
          fromBlock = toBlock + 1;
        }
      } while (toBlock !== "latest" && toBlock !== currentBlock.number);

      // Replay only the blocks that had some events.
      for (const [blockNumber, events] of Object.entries(plan)) {
        log.debug(`Processing block ${blockNumber}`);
        const historicalBlock = await provider.getBlock(Number(blockNumber));
        try {
          await processBlock(
            this,
            historicalBlock,
            events,
            currentBlock.number,
            currentBlock.timestamp
          );

          // Set the last processed block to this iteration's block number
          this.registry.lastProcessedBlock =
            blockToRegistryBlock(historicalBlock);
          await this.registry.write();

          // Set the block height metric
          blockHeight.labels(chainId.toString()).set(Number(blockNumber));
        } catch (err) {
          log.error(`Error processing block ${blockNumber}`, err);
        }

        log.debug(`Block ${blockNumber} has been processed`);
      }

      // Set the last processed block to the current block number
      this.registry.lastProcessedBlock = blockToRegistryBlock(currentBlock);

      // Save the registry
      await this.registry.write();

      // It may have taken some time to process the blocks, so refresh the current block number
      // and check if we are in sync
      currentBlock = await provider.getBlock("latest");

      // If we are in sync, let it be known
      if (currentBlock.number === this.registry.lastProcessedBlock.number) {
        this.sync = ChainSync.IN_SYNC;
      } else {
        // Otherwise, we need to keep processing blocks
        fromBlock = this.registry.lastProcessedBlock.number + 1;
        plan = {};
      }
    } while (this.sync === ChainSync.SYNCING);

    log.info(
      `💚 ${
        oneShot ? "Chain watcher is in sync" : "Chain watcher is warmed up"
      }`
    );
    log.debug(
      `Last processed block: ${this.registry.lastProcessedBlock.number}`
    );

    // If one-shot, return
    if (oneShot) {
      return;
    }

    // Otherwise, run the block watcher
    return await this.runBlockWatcher(currentBlock);
  }

  /**
   * Run the block watcher for the chain. As new blocks come in:
   * 1. Check if there are any `ConditionalOrderCreated` events, and index these.
   * 2. Check if any orders want to create discrete orders.
   */
  private async runBlockWatcher(lastProcessedBlock: providers.Block) {
    const { provider, registry, chainId, watchdogTimeout } = this;
    const log = getLogger("chainContext:runBlockWatcher", chainId.toString());
    // Watch for new blocks
    log.info(`👀 Start block watcher`);
    log.debug(`Watchdog timeout: ${watchdogTimeout} seconds`);
    let lastBlockReceived = lastProcessedBlock;
    provider.on("block", async (blockNumber: number) => {
      try {
        const block = await provider.getBlock(blockNumber);
        log.debug(`New block ${blockNumber}`);

        // Set the block time metric
        const _blockTime = block.timestamp - lastBlockReceived.timestamp;
        blockProducingRate.labels(chainId.toString()).set(_blockTime);

        if (
          blockNumber <= lastBlockReceived.number &&
          block.hash !== lastBlockReceived.hash
        ) {
          // This is a re-org, so process the block again
          reorgsTotal.labels(chainId.toString()).inc();
          log.info(`Re-org detected, re-processing block ${blockNumber}`);
          reorgDepth
            .labels(chainId.toString())
            .set(lastBlockReceived.number - blockNumber + 1);
        }
        lastBlockReceived = block;

        const events = await pollContractForEvents(
          blockNumber,
          blockNumber,
          this
        );

        try {
          await processBlock(this, block, events);

          // Block height metric
          this.registry.lastProcessedBlock = blockToRegistryBlock(block);
          this.registry.write();
          blockHeight.labels(chainId.toString()).set(Number(blockNumber));
        } catch {
          log.error(`Error processing block ${blockNumber}`);
        }

        log.debug(`Block ${blockNumber} has been processed`);
      } catch (error) {
        log.error(
          `Error in pollContractForEvents for block ${blockNumber}`,
          error
        );
      }
    });

    // We run a watchdog to check if we are receiving blocks. This determines if
    // the chain is stuck or not issuing blocks. If running within a kubernetes
    // pod, we don't exit, but we do log an error and set the sync status to unknown.
    while (true) {
      // sleep for 5 seconds
      await asyncSleep(WATCHDOG_FREQUENCY);
      const now = Math.floor(new Date().getTime() / 1000);
      const timeElapsed = now - lastBlockReceived.timestamp;

      log.debug(`Time since last block processed: ${timeElapsed}s`);

      // If we haven't received a block within `watchdogTimeout` seconds, either signal
      // an error or exit if not running in a kubernetes pod
      if (timeElapsed >= watchdogTimeout) {
        log.error(
          `Chain watcher last processed a block ${timeElapsed}s ago (${watchdogTimeout}s timeout configured). Check the RPC.`
        );
        if (isRunningInKubernetesPod()) {
          this.sync = ChainSync.UNKNOWN;
          continue;
        }

        // We need to handle our own exit here as the process is not running in a kubernetes pod
        await registry.storage.close();
        process.exit(1);
      }
    }
  }

  /** Get the specific chain's health */
  get health(): ChainHealth {
    const { sync, chainId } = this;
    return {
      sync,
      chainId,
      lastProcessedBlock: this.registry.lastProcessedBlock,
      isHealthy: this.isHealthy(),
    };
  }

  /** Determine if the specific chain is healthy */
  private isHealthy(): boolean {
    return this.sync === ChainSync.IN_SYNC;
  }

  /** Get the health status of all the chains, and the overall status */
  static get health(): ChainWatcherHealth {
    const chains = Object.values(ChainContext.chains).reduce(
      (acc, chain) => {
        const { chainId } = chain;
        acc.chains[Number(chainId.toString())] = chain.health;
        acc.overallHealth = acc.overallHealth && chain.isHealthy();
        return acc;
      },
      { chains: {}, overallHealth: true } as ChainWatcherHealth
    );

    return chains;
  }

  /** Determine if all chains are healthy */
  static isHealthy(): boolean {
    return ChainContext.health.overallHealth;
  }
}

/**
 * Process events in a block.
 * @param context of the chain who's block is being processed
 * @param block from which the events were emitted
 * @param events an array of conditional order created events
 * @param blockNumberOverride to override the block number when polling the SDK
 * @param blockTimestampOverride  to override the block timestamp when polling the SDK
 */
async function processBlock(
  context: ChainContext,
  block: providers.Block,
  events: ConditionalOrderCreatedEvent[],
  blockNumberOverride?: number,
  blockTimestampOverride?: number
) {
  const { provider, chainId, filterPolicy } = context;
  const timer = processBlockDurationSeconds
    .labels(context.chainId.toString())
    .startTimer();
  const log = getLogger(
    "chainContext:processBlock",
    chainId.toString(),
    block.number.toString()
  );

  // Refresh the policy every hour
  // NOTE: This is a temporary solution until we have a better way to update the filter policy
  const blocksPerFilterFrequency =
    FILTER_FREQUENCY_SECS /
    (context.chainId === SupportedChainId.GNOSIS_CHAIN ? 5 : 12); // 5 seconds for gnosis, 12 seconds for mainnet
  if (
    filterPolicy &&
    block.number % (FILTER_FREQUENCY_SECS / blocksPerFilterFrequency) == 0
  ) {
    filterPolicy.reloadPolicies().catch((error) => {
      console.log(`Error fetching the filter policy config for chain `, error);
      return null;
    });
  }

  // Transaction watcher for adding new contracts
  let hasErrors = false;
  for (const event of events) {
    const receipt = await provider.getTransactionReceipt(event.transactionHash);
    if (receipt) {
      // run action
      log.debug(`Running "addContract" action for TX ${event.transactionHash}`);
      const result = await addContract(context, event)
        .then(() => true)
        .catch((e) => {
          hasErrors = true;
          log.error(`Error running "addContract" action for TX:`, e);
          return false;
        });
      log.info(`Result of "addContract": ${_formatResult(result)}`);
      eventsProcessedTotal.labels(chainId.toString()).inc();
    }
  }

  // run action
  const result = await checkForAndPlaceOrder(
    context,
    block,
    blockNumberOverride,
    blockTimestampOverride
  )
    .then(() => true)
    .catch(() => {
      hasErrors = true;
      log.error(`Error running "checkForAndPlaceOrder" action`);
      return false;
    });
  log.debug(
    `Result of "checkForAndPlaceOrder" action for block ${
      block.number
    }: ${_formatResult(result)}`
  );

  timer();
  if (hasErrors) {
    throw new Error("Errors found in processing block");
  }
}

function pollContractForEvents(
  fromBlock: number,
  toBlock: number | "latest",
  context: ChainContext
): Promise<ConditionalOrderCreatedEvent[]> {
  const { provider, chainId, addresses } = context;
  const composableCow = composableCowContract(provider, chainId);
  const filter = composableCow.filters.ConditionalOrderCreated() as EventFilter;

  if (addresses) {
    filter.topics?.push(
      addresses.map((address) => hexZeroPad(address.toLowerCase(), 32))
    );
  }

  return composableCow.queryFilter(filter, fromBlock, toBlock);
}

function _formatResult(result: boolean) {
  return result ? "✅" : "❌";
}

async function asyncSleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
