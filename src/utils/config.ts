/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { logger } from './logger';

export enum LogAuthDriver {
  None = 'none',
  Webhook = 'webhook',
  Googlesheets = 'googlesheets',
}

export enum UnifiControllerType {
  Standalone = 'standalone',
  Integrated = 'integrated',
}

export enum Auth {
  None = 'none',
  Simple = 'simple',
  UserInfo = 'userInfo',
  Custom = 'custom',
}

export interface ControllerConfig {
  url?: string; // Optional - can be "auto" or empty for dynamic detection
  username: string;
  password: string;
  type: UnifiControllerType;
  siteIdentifier: string;
  enabled: boolean;
}

type Config = {
  // Multi-controller config (required)
  unifiControllers: ControllerConfig[];

  // Application config
  sessionSecret: string;
  auth: Auth;
  redirectUrl: string;
  serverSideRedirect: string;
  showConnecting: string;
  logAuthDriver: LogAuthDriver;
  port?: string;
};

// Parse multi-controller configuration
function parseControllerConfig(): ControllerConfig[] {
  const controllersJson = process.env.UNIFI_CONTROLLERS;

  if (!controllersJson) {
    logger.error('UNIFI_CONTROLLERS environment variable is required');
    logger.error(
      'Example: UNIFI_CONTROLLERS=[{"url":"auto","username":"admin","password":"pass","type":"standalone","siteIdentifier":"default","enabled":true}]',
    );
    process.exit(1);
  }

  try {
    const parsed = JSON.parse(controllersJson);
    if (!Array.isArray(parsed)) {
      logger.error('UNIFI_CONTROLLERS must be a JSON array');
      process.exit(1);
    }

    if (parsed.length === 0) {
      logger.error('UNIFI_CONTROLLERS array cannot be empty');
      process.exit(1);
    }

    return parsed.map((ctrl: any, index: number) => {
      // Validate required fields
      if (!ctrl.username) {
        logger.error(`Controller ${index}: missing required field 'username'`);
        process.exit(1);
      }
      if (!ctrl.password) {
        logger.error(`Controller ${index}: missing required field 'password'`);
        process.exit(1);
      }

      return {
        url: ctrl.url || 'auto', // Default to auto-detection
        username: ctrl.username,
        password: ctrl.password,
        type:
          (ctrl.type as UnifiControllerType) || UnifiControllerType.Integrated, // Default to integrated for UX7
        siteIdentifier: ctrl.siteIdentifier || 'default',
        enabled: ctrl.enabled !== false, // Default to true
      };
    });
  } catch (error) {
    logger.error('Failed to parse UNIFI_CONTROLLERS JSON:', error);
    logger.error(
      'Example: UNIFI_CONTROLLERS=[{"url":"auto","username":"admin","password":"pass","type":"integrated","siteIdentifier":"default","enabled":true}]',
    );
    process.exit(1);
  }
}

const controllers = parseControllerConfig();

const config: Config = {
  // Multi-controller config
  unifiControllers: controllers,

  // Application config
  sessionSecret: process.env.SESSION_SECRET || 'secret',
  auth: (process.env.AUTH as Auth) || Auth.Simple,
  redirectUrl: process.env.REDIRECTURL || '/success.html',
  serverSideRedirect: process.env.SERVER_SIDE_REDIRECT || 'true',
  showConnecting: process.env.SHOW_CONNECTING || 'true',
  logAuthDriver:
    (process.env.LOG_AUTH_DRIVER as LogAuthDriver) || LogAuthDriver.None,
  port: process.env.PORT || '4545',
};

function checkForRequiredEnvVars(): void {
  // Validate controllers are configured
  if (!config.unifiControllers || config.unifiControllers.length === 0) {
    logger.error('No valid controllers configured');
    process.exit(1);
  }

  // Validate each controller
  config.unifiControllers.forEach((ctrl, index) => {
    if (!ctrl.username || !ctrl.password) {
      logger.error(`Controller ${index}: missing username or password`);
      process.exit(1);
    }

    // Validate controller type
    if (!Object.values(UnifiControllerType).includes(ctrl.type)) {
      logger.error(
        `Controller ${index}: Invalid type '${ctrl.type}'. Expected one of: ${Object.values(UnifiControllerType).join(', ')}`,
      );
      process.exit(1);
    }
  });

  logger.debug('All required controller configurations are valid');
}

function validateConfig(): void {
  // Validate LogAuthDriver
  if (!Object.values(LogAuthDriver).includes(config.logAuthDriver)) {
    logger.error(
      `Invalid value for LOG_AUTH_DRIVER. Expected one of: ${Object.values(LogAuthDriver).join(', ')}`,
    );
    process.exit(1);
  }

  // Validate Auth
  if (!Object.values(Auth).includes(config.auth)) {
    logger.error(
      `Invalid value for AUTH. Expected one of: ${Object.values(Auth).join(', ')}`,
    );
    process.exit(1);
  }

  logger.debug('Configuration is valid');
  logger.info(`Configured ${config.unifiControllers.length} controller(s)`);
  config.unifiControllers.forEach((ctrl, index) => {
    const urlDisplay =
      ctrl.url === 'auto' ? 'auto-detect' : ctrl.url || 'auto-detect';
    logger.info(`  Controller ${index}: ${urlDisplay} (${ctrl.type})`);
  });
}

function maskSensitiveConfig(config: Config): Partial<Config> {
  return {
    ...config,
    unifiControllers: config.unifiControllers.map((ctrl) => ({
      ...ctrl,
      password: '****',
    })),
  };
}

export { config, validateConfig, checkForRequiredEnvVars, maskSensitiveConfig };
