const dns = require('node:dns/promises');
const path = require('node:path');
const Redis = require('ioredis');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const baseDomain = String(process.env.BASE_DOMAIN || 'pusat.email').toLowerCase();
const requiredMxHost = String(process.env.REQUIRED_MX_HOST || 'mail.pusat.email').toLowerCase();
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const redisPassword = process.env.REDIS_PASSWORD || 'd0535500cb173f97';
const cacheTtlSeconds = Number.parseInt(process.env.DOMAIN_MX_CACHE_TTL_SECONDS || '300', 10);

let redis;

const getRedis = () => {
  if (!redis) {
    redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      lazyConnect: true,
      password: redisPassword || undefined,
      retryStrategy(times) {
        if (times > 10) return null;
        return Math.min(times * 250, 2000);
      },
      reconnectOnError() {
        return false;
      }
    });
  }

  return redis;
};

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

const getDomainFromEmail = (email) => {
  const normalized = normalizeEmail(email);
  const atIndex = normalized.lastIndexOf('@');
  return atIndex === -1 ? '' : normalized.slice(atIndex + 1);
};

const normalizeDomain = (domain) => String(domain || '').trim().toLowerCase().replace(/\.$/, '');

const isBaseDomain = (domain) => {
  const normalized = normalizeDomain(domain);
  return normalized === baseDomain || normalized.endsWith(`.${baseDomain}`);
};

const isRegisteredDomainActive = async (domain) => {
  const normalized = normalizeDomain(domain);
  const client = getRedis();

  if ((await client.sismember('domains:active', normalized)) === 1) return true;

  const parts = normalized.split('.');
  for (let index = 1; index < parts.length - 1; index += 1) {
    const parent = parts.slice(index).join('.');
    if ((await client.sismember('domains:active', parent)) === 1) return true;
  }

  return false;
};

const validateDomainMx = async (domain) => {
  const normalized = normalizeDomain(domain);
  if (!normalized) return false;
  if (isBaseDomain(normalized)) return true;
  if (await isRegisteredDomainActive(normalized)) return true;

  const client = getRedis();
  const key = `domain_mx:${normalized}`;
  const cached = await client.get(key);
  if (cached) return cached === 'valid';

  let valid = false;
  try {
    const records = await dns.resolveMx(normalized);
    valid = records.some((record) => {
      const exchange = String(record.exchange || '').toLowerCase().replace(/\.$/, '');
      return exchange === requiredMxHost;
    });
  } catch (error) {
    valid = false;
  }

  await client.set(key, valid ? 'valid' : 'invalid', 'EX', cacheTtlSeconds);
  return valid;
};

exports.register = function register() {
  this.register_hook('rcpt', 'hook_rcpt');
};

exports.hook_rcpt = async function hookRcpt(next, connection, params) {
  const recipient = params?.[0]?.address?.();
  const domain = getDomainFromEmail(recipient);

  try {
    const valid = await validateDomainMx(domain);
    if (!valid) {
      connection.logwarn(this, `reject recipient domain=${domain}`);
      return next(DENY, 'Recipient domain is not configured for this MX');
    }

    connection.transaction.notes.valid_recipients ||= [];
    connection.transaction.notes.valid_recipients.push(normalizeEmail(recipient));
    return next(OK);
  } catch (error) {
    connection.logerror(this, `MX validation failed: ${error.message}`);
    return next(DENYSOFT, 'Temporary recipient validation error');
  }
};
