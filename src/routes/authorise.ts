import express, { Request, Response } from 'express';
import { logger } from '../utils/logger';
import { webhook, googleSheets } from '../utils/logAuthDrivers';
import { config, UnifiControllerType, ControllerConfig } from '../utils/config';
import { createAxiosInstance } from '../utils/axios';
import { AxiosInstance } from 'axios';

import { UnifiApiService } from '../interfaces/UnifiApiService';
import { standaloneUnifiModule, integratedUnifiModule } from '../unifi/index';

const authoriseRouter = express.Router();

const unifiAuthServices: Record<UnifiControllerType, UnifiApiService> = {
  standalone: standaloneUnifiModule,
  integrated: integratedUnifiModule,
};

/**
 * Authorize a guest on a single controller
 */
async function authorizeOnController(
  controllerConfig: ControllerConfig,
  req: Request,
): Promise<{ success: boolean; error?: string }> {
  try {
    const unifiApiClient = createAxiosInstance(controllerConfig.url);
    const selectedModule = unifiAuthServices[controllerConfig.type];

    logger.info(
      `Authorizing on controller: ${controllerConfig.url} (${controllerConfig.type})`,
    );

    // Login to controller with controller-specific credentials
    await selectedModule.login(unifiApiClient, controllerConfig);

    // Authorize the device
    await selectedModule.authorise(unifiApiClient, req, controllerConfig);

    // Logout from controller
    await selectedModule.logout(unifiApiClient);

    logger.info(
      `Successfully authorized on controller: ${controllerConfig.url}`,
    );
    return { success: true };
  } catch (err: any) {
    const errorMsg = err?.message || 'Unknown error';
    logger.error(
      `Failed to authorize on controller ${controllerConfig.url}: ${errorMsg}`,
    );
    return { success: false, error: errorMsg };
  }
}

/**
 * Authorize guest on configured controllers
 * Returns immediately on first success, but continues all requests in background
 */
async function authorizeGuest(req: Request, res: Response): Promise<void> {
  const enabledControllers = config.unifiControllers.filter(
    (ctrl) => ctrl.enabled,
  );

  logger.info(
    `Authorizing guest on ${enabledControllers.length} controller(s)`,
  );

  // Log user authentication first
  if (config.logAuthDriver) {
    await logAuth(req.body);
  }

  // Start authorization on all controllers in parallel
  const authPromises = enabledControllers.map((ctrl) =>
    authorizeOnController(ctrl, req),
  );

  // Race all promises - return immediately on first success
  let hasResponded = false;
  let successCount = 0;
  let failureCount = 0;

  // Process results as they complete
  const racePromise = Promise.race(
    authPromises.map(async (promise, index) => {
      try {
        const result = await promise;
        if (result.success && !hasResponded) {
          hasResponded = true;
          successCount++;
          logger.info(
            `First controller succeeded (${enabledControllers[index].url}), responding to client`,
          );
          return { success: true, index };
        }
        if (result.success) {
          successCount++;
        } else {
          failureCount++;
        }
        return { success: result.success, index };
      } catch (error) {
        failureCount++;
        return { success: false, index };
      }
    }),
  );

  // Wait for first success or all failures
  try {
    const firstResult = await Promise.race([
      racePromise,
      // If all fail, wait for all to complete
      Promise.allSettled(authPromises).then(() => ({
        success: false,
        index: -1,
      })),
    ]);

    if (firstResult.success) {
      // Respond to client immediately
      if (config.showConnecting === 'true') {
        logger.debug(`Redirecting to ${'./connecting'}`);
        res.redirect('./connecting');
      } else if (config.serverSideRedirect === 'true') {
        // sleep 5s
        await new Promise((r) => setTimeout(r, 5000));
        logger.debug(`Redirecting to ${config.redirectUrl}`);
        res.redirect(config.redirectUrl);
      } else {
        res.status(200).json({ success: true });
      }

      // Continue processing remaining controllers in background
      Promise.allSettled(authPromises).then((results) => {
        const finalSuccesses = results.filter(
          (r) => r.status === 'fulfilled' && r.value.success,
        ).length;
        const finalFailures = results.length - finalSuccesses;
        logger.info(
          `All controller authorizations complete: ${finalSuccesses} succeeded, ${finalFailures} failed`,
        );
      });
    } else {
      // All controllers failed
      throw new Error('Failed to authorize on all controllers');
    }
  } catch (error) {
    throw new Error('Failed to authorize on all controllers');
  }
}

authoriseRouter.route('/').post(async (req: Request, res: Response) => {
  try {
    await authorizeGuest(req, res);
  } catch (err) {
    logger.error('Authorization error:', err);
    res.status(500).json({
      err: {
        message: 'An Error has occurred. Please try again.',
      },
    });
  }
});

export default authoriseRouter;

// Handle LogAuth
const logAuth = async (formData: any): Promise<void> => {
  switch (config.logAuthDriver) {
    case 'webhook':
      await webhook(formData);
      break;
    case 'googlesheets':
      await googleSheets(formData);
      break;
    default:
      break;
  }
};
