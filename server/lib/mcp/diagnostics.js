import { logger } from '../../logger.js';

const methods = new Set(['server/discover','initialize','notifications/initialized','tools/list','tools/call','ping']);
const scopes = ['mcp:read','mcp:write','mcp:goals:write','mcp:destroy'];
const reasons = new Set(['auth_missing','oauth_disabled','oauth_not_configured','oauth_provider_unavailable','oauth_provider_invalid','jwt_issuer','jwt_audience','jwt_expired','jwt_exp','jwt_iat','jwt_sub','jwt_nbf','jwt_signature','jwt_key','jwt_time','jwt_invalid','owner_mismatch','client_mismatch','local_user_missing','auth_scope','origin_rejected']);

// Explicit field allowlist: no headers, claims, identity values, token, args,
// health data, arbitrary error messages or request bodies ever enter this log.
export function mcpDiagnostics(req, res, next) {
  if (req.method !== 'POST' && req.method !== 'OPTIONS') return next();
  res.once('finish', () => {
    const protocol = req.get('mcp-protocol-version');
    const metaVersion = req.body?.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
    const safeVersion = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : value == null ? 'absent' : 'other';
    const auth = req.mcpAuth;
    const record = {
      request_id: typeof req.requestId === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(req.requestId) ? req.requestId : null,
      http_method: req.method,
      method: methods.has(req.body?.method) ? req.body.method : 'other',
      status: res.statusCode,
      protocol: safeVersion(protocol),
      meta_protocol: safeVersion(metaVersion),
      origin_present: !!req.get('origin'),
      auth_kind: ['pat','oauth'].includes(auth?.authKind) ? auth.authKind : 'none',
      scopes: scopes.filter(scope => auth?.scopes?.includes(scope)),
      reason: reasons.has(res.locals.mcpFailure) ? res.locals.mcpFailure : null,
      rpc_error: res.locals.mcpRpcError ?? null,
      tool_count: res.locals.mcpToolCount ?? null,
    };
    logger.info('[mcp:diagnostic] ' + JSON.stringify(record));
  });
  next();
}
