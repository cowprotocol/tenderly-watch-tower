import { RunSingleOptions } from "../types";
import { getLogger, DBService } from "../utils";
import { ChainContext } from "../domain";
import { ApiService } from "../utils/api";

/**
 * Run the watch-tower 👀🐮
 * @param options Specified by the CLI / environment for running the watch-tower
 */
export async function run(options: RunSingleOptions) {
  const log = getLogger("commands:run");
  const { oneShot, disableApi, apiPort, databasePath, watchdogTimeout } =
    options;

  // Open the database
  const storage = DBService.getInstance(databasePath);

  // Start the API server if it's not disabled
  if (!disableApi) {
    log.info("Starting Rest API server...");
    const api = ApiService.getInstance(apiPort);
    await api.start();
  }

  process.on("unhandledRejection", async (error) => {
    log.error("Unhandled promise rejection", error);
    await stop(1);
  });

  process.on("SIGINT", async function () {
    log.info("Caught interrupt signal.");
    await stop();
  });

  let exitCode = 0;
  try {
    const chainContext = await ChainContext.init(options, storage);
    const runPromise = chainContext.warmUp(watchdogTimeout, oneShot);

    // Run the block watcher after warm up for the chain
    await runPromise;
  } catch (error) {
    log.error("Unexpected error thrown when running watchtower", error);
    exitCode = 1;
  } finally {
    await stop(exitCode);
  }
}

/**
 * Run actions required when stopping the watch-tower from run mode
 * @param exitCode Exit code to return to the shell
 */
async function stop(exitCode?: number) {
  const log = getLogger("commands:stop");
  const stopServices = [
    ApiService.getInstance().stop(),
    DBService.getInstance().close(),
  ];
  await Promise.allSettled(stopServices).then((results) => {
    results.forEach((result) => {
      if (result.status === "rejected") {
        log.error("Error stopping service", result.reason);
      }
    });
  });
  log.info("Exiting watchtower...");
  process.exit(exitCode || 0);
}
