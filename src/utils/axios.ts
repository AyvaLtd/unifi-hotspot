import axios, { AxiosInstance } from 'axios';
import { HttpCookieAgent, HttpsCookieAgent } from 'http-cookie-agent/http';
import { CookieJar } from 'tough-cookie';
import { logger } from './logger';
import { config } from './config';
import { Request } from 'express';

/**
 * Detect UniFi controller URL from the request
 * The controller IP/URL is typically where the captive portal redirect originated
 */
export const detectControllerUrl = (req: Request): string | null => {
  // Priority 1: Check for explicit gateway parameter in query string
  // UniFi controllers may pass this in some configurations
  const gateway = req.query.gw || req.query.gateway;
  if (gateway && typeof gateway === 'string') {
    const gatewayUrl = `https://${gateway}`;
    logger.info(`Detected controller from gateway parameter: ${gatewayUrl}`);
    return gatewayUrl;
  }

  // Priority 2: Extract from Referer header
  // The referer should contain the controller URL that redirected the user to this portal
  const referer = req.headers['referer'] || req.headers['referrer'];
  if (referer) {
    try {
      // Ensure referer is a string (headers can be string | string[])
      const refererString = Array.isArray(referer) ? referer[0] : referer;
      const url = new URL(refererString);

      // Only use referer if it's not pointing to this portal server
      // Check if the referer host is different from the current request host
      const currentHost = req.headers['host'];
      if (url.host !== currentHost) {
        logger.info(`Detected controller URL from referer: ${url.origin}`);
        return url.origin;
      } else {
        logger.debug('Referer points to portal server, not controller');
      }
    } catch (error) {
      logger.debug('Failed to parse referer URL');
    }
  }

  // Priority 3: Check X-UniFi-AP header
  // Some UniFi setups include the AP or controller information in custom headers
  const unifiAp =
    req.headers['x-unifi-ap'] || req.headers['x-unifi-controller'];
  if (unifiAp && typeof unifiAp === 'string') {
    const apUrl = `https://${unifiAp}`;
    logger.info(`Detected controller from X-UniFi header: ${apUrl}`);
    return apUrl;
  }

  // Priority 4: Try to extract from session redirect_url parameter
  // Some UniFi setups include the controller in the url parameter
  const redirectUrl = req.query.url;
  if (redirectUrl && typeof redirectUrl === 'string') {
    try {
      const url = new URL(redirectUrl);
      // Check if this looks like a controller URL (has specific patterns)
      if (url.hostname.includes('unifi') || url.pathname.includes('inform')) {
        logger.info(`Detected controller URL from redirect URL: ${url.origin}`);
        return url.origin;
      }
    } catch (error) {
      logger.debug('Failed to parse redirect URL');
    }
  }

  logger.warn(
    'Could not auto-detect controller URL from request headers or parameters',
  );
  logger.debug('Request details:', {
    referer: req.headers['referer'],
    host: req.headers['host'],
    query: req.query,
  });

  return null;
};

/**
 * Create an Axios instance for a specific controller URL
 */
export const createAxiosInstance = (
  controllerUrl?: string,
  req?: Request,
): AxiosInstance => {
  let baseURL = controllerUrl;

  // If URL is "auto" or not provided, try to detect it
  if (!baseURL || baseURL === 'auto') {
    if (req) {
      const detectedUrl = detectControllerUrl(req);
      if (detectedUrl) {
        baseURL = detectedUrl;
        logger.info(`Using auto-detected controller URL: ${baseURL}`);
      } else {
        logger.error('Failed to auto-detect controller URL from request');
        throw new Error(
          'Unable to determine controller URL - auto-detection failed and no URL specified',
        );
      }
    } else {
      logger.error('Cannot auto-detect controller URL without request context');
      throw new Error('Request context required for auto-detection');
    }
  }

  const jar = new CookieJar();

  const instance = axios.create({
    baseURL,
    httpAgent: new HttpCookieAgent({ cookies: { jar } }),
    httpsAgent: new HttpsCookieAgent({
      cookies: { jar },
      rejectUnauthorized: false,
    }),
  });

  // Request interceptor
  instance.interceptors.request.use(
    (request) => {
      logger.debug(
        `Starting Request: ${request.method?.toUpperCase()} ${request.baseURL}${request.url}`,
      );
      logger.debug(`Request Headers: ${JSON.stringify(request.headers)}`);
      if (request.data) {
        logger.debug(`Request Data: ${JSON.stringify(request.data)}`);
      }
      return request;
    },
    (error) => {
      logger.error(`Request Error: ${error.message}`);
      return Promise.reject();
    },
  );

  // Response interceptor
  instance.interceptors.response.use(
    (response) => {
      logger.info(
        `Response from ${response.config.url}: ${response.status} ${response.statusText}`,
      );
      logger.debug(`Response Headers: ${JSON.stringify(response.headers)}`);
      logger.debug(`Response Data: ${JSON.stringify(response.data)}`);
      return response;
    },
    (error) => {
      if (error.response) {
        logger.error(
          `Server responded with an error from ${error.response.config.url}: ${error.response.status} ${error.response.statusText}`,
        );
        logger.error(`Error Data: ${JSON.stringify(error.response.data)}`);
      } else if (error.request) {
        logger.error(`No response received: ${error.request}`);
      } else {
        logger.error(`Error: ${error.message}`);
      }
      return Promise.reject();
    },
  );

  return instance;
};
