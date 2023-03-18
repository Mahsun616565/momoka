import { sleep } from '../common/helpers';
import { consoleLog } from '../common/logger';
import { ClaimableValidatorError } from '../data-availability-models/claimable-validator-errors';
import { LOCAL_NODE_URL, setupAnvilLocalNode } from '../evm/anvil';
import { EthereumNode } from '../evm/ethereum';
import {
  getDataAvailabilityTransactionsAPI,
  getDataAvailabilityTransactionsAPIResponse,
} from '../input-output/bundlr/get-data-availability-transactions.api';
import { getLastEndCursorDb, saveEndCursorDb, startDb } from '../input-output/db';
import { checkDAProofsBatch } from '../proofs/check-da-proofs-batch';
import { retryCheckDAProofsQueue } from '../queue/known.queue';
import { startupQueues } from '../queue/startup.queue';
import { StartDAVerifierNodeOptions } from './models/start-da-verifier-node-options';

const startup = async (
  ethereumNode: EthereumNode,
  dbLocationFolderPath: string,
  usLocalNode: boolean
): Promise<void> => {
  if (usLocalNode) {
    // Start the local node up
    await setupAnvilLocalNode(ethereumNode.nodeUrl);
  }

  // Initialize database.
  startDb(dbLocationFolderPath);
  startupQueues();
  // verifierFailedSubmissionsWatcher(ethereumNode, dbLocationFolderPath);

  if (usLocalNode) {
    // Switch to local node.
    ethereumNode.nodeUrl = LOCAL_NODE_URL;
  }
};

/**
 * Starts the DA verifier node to watch for new data availability submissions and verify their proofs.
 * @param ethereumNode The Ethereum node to use for verification.
 * @param dbLocationFolderPath The folder path for the location of the database.
 * @param options An optional object containing options for the node.
 *                   - stream - A callback function to stream the validation results.
 *                   - syncFromHeadOnly - A boolean to indicate whether to sync from the head of the chain only.
 */
export const startDAVerifierNode = async (
  ethereumNode: EthereumNode,
  dbLocationFolderPath: string,
  usLocalNode = false,
  { stream }: StartDAVerifierNodeOptions = {}
): Promise<never> => {
  consoleLog('LENS VERIFICATION NODE - DA verification watcher started...');

  await startup(ethereumNode, dbLocationFolderPath, usLocalNode);

  // Get the last end cursor.
  let endCursor: string | null = await getLastEndCursorDb();

  let count = 0;

  consoleLog('LENS VERIFICATION NODE - started up..');

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      // Get new data availability transactions from the server.
      const arweaveTransactions: getDataAvailabilityTransactionsAPIResponse =
        await getDataAvailabilityTransactionsAPI(
          ethereumNode.environment,
          ethereumNode.deployment,
          endCursor
        );

      if (arweaveTransactions.edges.length === 0) {
        consoleLog('LENS VERIFICATION NODE - No new DA items found..');
        await sleep(100);
      } else {
        count++;
        consoleLog(
          'LENS VERIFICATION NODE - Found new submissions...',
          arweaveTransactions.edges.length
        );

        // Check DA proofs in batches of 1000 to avoid I/O issues.
        console.time('starting');
        const result = await checkDAProofsBatch(
          arweaveTransactions.edges.map((edge) => edge.node.id),
          ethereumNode,
          false,
          usLocalNode,
          stream
        );
        console.timeEnd('startings');

        // push the retry queue
        retryCheckDAProofsQueue.enqueueWithDelay(
          {
            txIds: result
              .filter(
                (c) =>
                  !c.success &&
                  // if the error is something based on network or node issues, then retry
                  (c.claimableValidatorError === ClaimableValidatorError.UNKNOWN ||
                    c.claimableValidatorError ===
                      ClaimableValidatorError.CAN_NOT_CONNECT_TO_BUNDLR ||
                    c.claimableValidatorError ===
                      ClaimableValidatorError.BLOCK_CANT_BE_READ_FROM_NODE ||
                    c.claimableValidatorError ===
                      ClaimableValidatorError.DATA_CANT_BE_READ_FROM_NODE ||
                    c.claimableValidatorError ===
                      ClaimableValidatorError.SIMULATION_NODE_COULD_NOT_RUN)
              )
              .map((c) => c.txId),
            ethereumNode,
            stream,
          },
          // try again in 30 seconds any failed ones
          30000
        );

        consoleLog('result done!', count);

        endCursor = arweaveTransactions.pageInfo.endCursor;
        await saveEndCursorDb(endCursor!);

        consoleLog('completed count', count);
      }
    } catch (error) {
      consoleLog('LENS VERIFICATION NODE - Error while checking for new submissions', error);
      await sleep(100);
    }
  }
};
