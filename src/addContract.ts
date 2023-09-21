import { BytesLike, ethers } from "ethers";

import type {
  ComposableCoW,
  ComposableCoWInterface,
  ConditionalOrderCreatedEvent,
  IConditionalOrder,
  MerkleRootSetEvent,
} from "./types/generated/ComposableCoW";
import { ComposableCoW__factory } from "./types/generated/factories/ComposableCoW__factory";

import {
  isComposableCowCompatible,
  handleExecutionError,
  writeRegistry,
} from "./utils";
import { Owner, Proof, Registry } from "./types/model";
import { ChainWatcher } from "./modes";

/**
 * Listens to these events on the `ComposableCoW` contract:
 * - `ConditionalOrderCreated`
 * - `MerkleRootSet`
 * @param chainWatcher chain watcher
 * @param event transaction event
 */
export const addContract = async (
  chainWatcher: ChainWatcher,
  event: ConditionalOrderCreatedEvent
) => {
  return _addContract(chainWatcher, event).catch(handleExecutionError);
};

const _addContract = async (
  context: ChainWatcher,
  event: ConditionalOrderCreatedEvent
) => {
  const composableCow = ComposableCoW__factory.createInterface();
  const { chainContext, registry } = context;
  const { provider } = chainContext;

  // Process the logs
  let hasErrors = false;
  let numContractsAdded = 0;

  // Do not process logs that are not from a `ComposableCoW`-compatible contract
  // This is a *normal* case, if the contract is not `ComposableCoW`-compatible
  // then we do not need to do anything, and therefore don't flag as an error.
  if (!isComposableCowCompatible(await provider.getCode(event.address))) {
    return;
  }
  const { error, added } = await _registerNewOrder(
    event,
    composableCow,
    registry
  );
  if (added) {
    numContractsAdded++;
  }
  hasErrors ||= error;

  console.log(`[addContract] Added ${numContractsAdded} contracts`);
  hasErrors ||= !(await writeRegistry());
  // Throw execution error if there was at least one error
  if (hasErrors) {
    throw Error(
      "[addContract] Error adding conditional order. Event: " + event
    );
  }
};

export async function _registerNewOrder(
  event: ConditionalOrderCreatedEvent | MerkleRootSetEvent,
  composableCow: ComposableCoWInterface,
  registry: Registry
): Promise<{ error: boolean; added: boolean }> {
  let added = false;
  try {
    // Check if the log is a ConditionalOrderCreated event
    if (
      event.topics[0] === composableCow.getEventTopic("ConditionalOrderCreated")
    ) {
      const log = event as ConditionalOrderCreatedEvent;
      // Decode the log
      const [owner, params] = composableCow.decodeEventLog(
        "ConditionalOrderCreated",
        log.data,
        log.topics
      ) as [string, IConditionalOrder.ConditionalOrderParamsStruct];

      // Attempt to add the conditional order to the registry
      await add(
        log.transactionHash,
        owner,
        params,
        null,
        log.address,
        registry
      );
      added = true;
    } else if (
      event.topics[0] == composableCow.getEventTopic("MerkleRootSet")
    ) {
      const log = event as MerkleRootSetEvent;
      const [owner, root, proof] = composableCow.decodeEventLog(
        "MerkleRootSet",
        log.data,
        log.topics
      ) as [string, BytesLike, ComposableCoW.ProofStruct];

      // First need to flush the owner's conditional orders that do not have the merkle root set
      flush(owner, root, registry);

      // Only continue processing if the proofs have been emitted
      if (proof.location === 1) {
        // Decode the proof.data
        const proofData = ethers.utils.defaultAbiCoder.decode(
          ["bytes[]"],
          proof.data as BytesLike
        );

        for (const order of proofData) {
          // Decode the order
          const decodedOrder = ethers.utils.defaultAbiCoder.decode(
            [
              "bytes32[]",
              "tuple(address handler, bytes32 salt, bytes staticInput)",
            ],
            order as BytesLike
          );
          // Attempt to add the conditional order to the registry
          await add(
            event.transactionHash,
            owner,
            decodedOrder[1],
            { merkleRoot: root, path: decodedOrder[0] },
            log.address,
            registry
          );
          added = true;
        }
      }
    }
  } catch (error) {
    console.error(
      "[addContract] Error handling ConditionalOrderCreated/MerkleRootSet event" +
        error
    );
    return { error: true, added };
  }

  return { error: false, added };
}

/**
 * Attempt to add an owner's conditional order to the registry
 *
 * @param owner to add the conditional order to
 * @param params for the conditional order
 * @param proof for the conditional order (if it is part of a merkle root)
 * @param composableCow address of the contract that emitted the event
 * @param registry of all conditional orders
 */
export const add = async (
  tx: string,
  owner: Owner,
  params: IConditionalOrder.ConditionalOrderParamsStruct,
  proof: Proof | null,
  composableCow: string,
  registry: Registry
) => {
  const { handler, salt, staticInput } = params;
  if (registry.ownerOrders.has(owner)) {
    const conditionalOrders = registry.ownerOrders.get(owner);
    console.log(
      `[register:add] Adding conditional order to already existing owner contract ${owner}`,
      { tx, handler, salt, staticInput }
    );
    let exists = false;
    // Iterate over the conditionalOrders to make sure that the params are not already in the registry
    for (const conditionalOrder of conditionalOrders?.values() ?? []) {
      // Check if the params are in the conditionalOrder
      if (conditionalOrder.params === params) {
        exists = true;
        break;
      }
    }

    // If the params are not in the conditionalOrder, add them
    if (!exists) {
      conditionalOrders?.add({
        tx,
        params,
        proof,
        orders: new Map(),
        composableCow,
      });
    }
  } else {
    console.log(
      `[register:add] Adding conditional order to new owner contract ${owner}:`,
      { tx, handler, salt, staticInput }
    );
    registry.ownerOrders.set(
      owner,
      new Set([{ tx, params, proof, orders: new Map(), composableCow }])
    );
  }
};

/**
 * Flush the conditional orders of an owner that do not have the merkle root set
 * @param owner to check for conditional orders to flush
 * @param root the merkle root to check against
 * @param registry of all conditional orders
 */
export const flush = async (
  owner: Owner,
  root: BytesLike,
  registry: Registry
) => {
  if (registry.ownerOrders.has(owner)) {
    const conditionalOrders = registry.ownerOrders.get(owner);
    if (conditionalOrders !== undefined) {
      for (const conditionalOrder of conditionalOrders.values()) {
        if (
          conditionalOrder.proof !== null &&
          conditionalOrder.proof.merkleRoot !== root
        ) {
          // Delete the conditional order
          conditionalOrders.delete(conditionalOrder);
        }
      }
    }
  }
};
