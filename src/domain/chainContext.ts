import {
  SingularRunOptions,
  Registry,
  ReplayPlan,
  ConditionalOrderCreatedEvent,
} from "../types";
import { SupportedChainId } from "@cowprotocol/cow-sdk";
import { addContract } from "./addContract";
import { checkForAndPlaceOrder } from "./checkForAndPlaceOrder";
import { ethers } from "ethers";
import { apiUrl, composableCowContract, DBService } from "../utils";

/**
 * The chain context handles watching a single chain for new conditional orders
 * and executing them.
 */
export class ChainContext {
  private readonly deploymentBlock: number;
  private readonly pageSize: number;
  private readonly dryRun: boolean;
  private inSync = false;

  provider: ethers.providers.Provider;
  apiUrl: string;
  chainId: SupportedChainId;
  registry: Registry;

  protected constructor(
    options: SingularRunOptions,
    provider: ethers.providers.Provider,
    chainId: SupportedChainId,
    registry: Registry
  ) {
    const { deploymentBlock, pageSize, dryRun } = options;
    this.deploymentBlock = deploymentBlock;
    this.pageSize = pageSize;
    this.dryRun = dryRun;

    this.provider = provider;
    this.apiUrl = apiUrl(chainId);
    this.chainId = chainId;
    this.registry = registry;
  }

  /**
   * Initialise a chain context.
   * @param options as parsed by commander from the command line arguments.
   * @param storage the db singleton that provides persistence.
   * @returns A chain context that is monitoring for orders on the chain.
   */
  public static async init(
    options: SingularRunOptions,
    storage: DBService
  ): Promise<ChainContext> {
    const { rpc, deploymentBlock } = options;

    const provider = new ethers.providers.JsonRpcProvider(rpc);
    const chainId = (await provider.getNetwork()).chainId;

    const registry = await Registry.load(
      storage,
      chainId.toString(),
      deploymentBlock
    );

    return new ChainContext(options, provider, chainId, registry);
  }

  /**
   * Warm up the chain watcher by fetching the latest block number and
   * checking if the chain is in sync.
   * @param oneShot if true, only warm up the chain watcher and return
   * @returns the run promises for what needs to be watched
   */
  public async warmUp(oneShot?: boolean) {
    const { provider, chainId } = this;
    const { lastProcessedBlock } = this.registry;
    const { pageSize } = this;
    const _ = (s: string) => console.log(`[warmUp:chainId:${chainId}] ${s}`);

    // Start watching from (not including) the last processed block (if any)
    let fromBlock = lastProcessedBlock
      ? lastProcessedBlock + 1
      : this.deploymentBlock;
    let currentBlockNumber = await provider.getBlockNumber();

    let plan: ReplayPlan = {};
    let toBlock: "latest" | number = 0;
    do {
      do {
        toBlock = !pageSize ? "latest" : fromBlock + (pageSize - 1);
        if (typeof toBlock === "number" && toBlock > currentBlockNumber) {
          // refresh the current block number
          currentBlockNumber = await provider.getBlockNumber();
          toBlock = toBlock > currentBlockNumber ? currentBlockNumber : toBlock;

          _(
            `Reaching tip of chain, current block number: ${currentBlockNumber}`
          );
        }

        _(`Processing events from block ${fromBlock} to block ${toBlock}`);

        const events = await pollContractForEvents(fromBlock, toBlock, this);

        _(`Found ${events.length} events`);

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
      } while (toBlock !== "latest" && toBlock !== currentBlockNumber);

      const block = await provider.getBlock(currentBlockNumber);

      // Replay only the blocks that had some events.
      for (const [blockNumber, events] of Object.entries(plan)) {
        _(`[run_rebuild] Processing block ${blockNumber}`);
        try {
          await processBlock(
            this,
            Number(blockNumber),
            events,
            block.number,
            block.timestamp
          );

          // Set the last processed block to this iteration's block number
          this.registry.lastProcessedBlock = Number(blockNumber);
          await this.registry.write();
        } catch {
          console.error(
            `[warmUp:chainId:${chainId}] Error processing block ${blockNumber}`
          );
        }
        _(`Block ${blockNumber} has been processed.`);
      }

      // Set the last processed block to the current block number
      this.registry.lastProcessedBlock = currentBlockNumber;

      // Save the registry
      await this.registry.write();

      // It may have taken some time to process the blocks, so refresh the current block number
      // and check if we are in sync
      currentBlockNumber = await provider.getBlockNumber();

      // If we are in sync, let it be known
      if (currentBlockNumber === this.registry.lastProcessedBlock) {
        this.inSync = true;
      } else {
        // Otherwise, we need to keep processing blocks
        this.inSync = false;
        fromBlock = this.registry.lastProcessedBlock + 1;
        plan = {};
      }
    } while (!this.inSync);

    _(oneShot ? "Chain watcher is in sync" : "Chain watcher is warmed up");
    _(`Last processed block: ${this.registry.lastProcessedBlock}`);

    // If one-shot, return
    if (oneShot) {
      return;
    }

    // Otherwise, run the block watcher
    return await this.runBlockWatcher();
  }

  /**
   * Run the block watcher for the chain. As new blocks come in:
   * 1. Check if there are any `ConditionalOrderCreated` events, and index these.
   * 2. Check if any orders want to create discrete orders.
   */
  public async runBlockWatcher() {
    const { provider, chainId } = this;
    const _ = (s: string) =>
      console.log(`[runBlockWatcher:chainId:${chainId}] ${s}`);
    // Watch for new blocks
    _("Subscribe to new blocks");
    provider.on("block", async (blockNumber: number) => {
      try {
        _(`New block ${blockNumber}`);

        const events = await pollContractForEvents(
          blockNumber,
          blockNumber,
          this
        );

        try {
          await processBlock(this, Number(blockNumber), events);
        } catch {
          console.error(
            `[runBlockWatcher:chainId:${chainId}] Error processing block ${blockNumber}`
          );
        }
        _(`Block ${blockNumber} has been processed.`);
      } catch (error) {
        console.error(
          `[runBlockWatcher:chainId:${chainId}] Error in processBlock`,
          error
        );
      }
    });
  }
}

/**
 * Process events in a block.
 * @param context of the chain who's block is being processed
 * @param blockNumber from which the events were emitted
 * @param events an array of conditional order created events
 * @param blockNumberOverride to override the block number when polling the SDK
 * @param blockTimestampOverride  to override the block timestamp when polling the SDK
 */
async function processBlock(
  context: ChainContext,
  blockNumber: number,
  events: ConditionalOrderCreatedEvent[],
  blockNumberOverride?: number,
  blockTimestampOverride?: number
) {
  const { provider } = context;
  const block = await provider.getBlock(blockNumber);

  // Transaction watcher for adding new contracts
  let hasErrors = false;
  for (const event of events) {
    const receipt = await provider.getTransactionReceipt(event.transactionHash);
    if (receipt) {
      // run action
      console.log(
        `[processBlock] Run "addContract" action for TX ${event.transactionHash}`
      );
      const result = await addContract(context, event)
        .then(() => true)
        .catch((e) => {
          hasErrors = true;
          console.error(
            `[run_local] Error running "addContract" action for TX:`,
            e
          );
          return false;
        });
      console.log(
        `[run_local] Result of "addContract" action for TX ${
          event.transactionHash
        }: ${_formatResult(result)}`
      );
    }
  }

  // run action
  console.log(`[processBlock] checkForAndPlaceOrder for block ${blockNumber}`);
  const result = await checkForAndPlaceOrder(
    context,
    block,
    blockNumberOverride,
    blockTimestampOverride
  )
    .then(() => true)
    .catch(() => {
      hasErrors = true;
      console.log(`[run_local] Error running "checkForAndPlaceOrder" action`);
      return false;
    });
  console.log(
    `[run_local] Result of "checkForAndPlaceOrder" action for block ${blockNumber}: ${_formatResult(
      result
    )}`
  );

  if (hasErrors) {
    throw new Error("[run_local] Errors found in processing block");
  }
}

function pollContractForEvents(
  fromBlock: number,
  toBlock: number | "latest",
  context: ChainContext
): Promise<ConditionalOrderCreatedEvent[]> {
  const { provider, chainId } = context;
  const composableCow = composableCowContract(provider, chainId);
  const filter = composableCow.filters.ConditionalOrderCreated();
  return composableCow.queryFilter(filter, fromBlock, toBlock);
}

function _formatResult(result: boolean) {
  return result ? "✅" : "❌";
}