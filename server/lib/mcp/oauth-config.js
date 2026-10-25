export const envFlag = v => ['1','true','yes','on'].includes(String(v || '').trim().toLowerCase());
export class McpAuthError extends Error {
  constructor(status, code, scope) { super(code); Object.assign(this, {status, code, scope}); }
}
const configError = () => new McpAuthError(503, 'oauth_not_configured');
function httpsUrl(raw) {
  let u; try { u = new URL(raw); } catch { throw configError(); }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw configError();
  return u;
}
export function oauthConfig(env = process.env) {
  if (!envFlag(env.MCP_OAUTH_ENABLED)) throw new McpAuthError(401, 'oauth_disabled');
  const resource = httpsUrl(env.MCP_OAUTH_RESOURCE_URL);
  const base = (env.BASE_URL || '').replace(/\/$/,'');
  if (resource.pathname !== `${base}/api/mcp`) throw configError();
  const issuer = httpsUrl(env.MCP_OAUTH_ISSUER);
  if (issuer.pathname !== '/') throw configError();
  const userId = Number(env.MCP_OAUTH_USER_ID);
  const owner = env.MCP_OAUTH_OWNER_SUB, clientId = env.MCP_OAUTH_CLIENT_ID;
  if (!Number.isSafeInteger(userId) || userId <= 0 || !owner || !clientId) throw configError();
  const validAfter = env.MCP_OAUTH_VALID_AFTER ? Date.parse(env.MCP_OAUTH_VALID_AFTER) / 1000 : 0;
  if (!Number.isFinite(validAfter) || validAfter < 0) throw configError();
  return {resource: resource.href, origin: resource.origin, issuer: issuer.href, userId, owner, clientId, validAfter};
}
export function resourceMetadata(config = oauthConfig()) {
  return { resource: config.resource, authorization_servers:[config.issuer],
    scopes_supported:['mcp:read','mcp:write','mcp:goals:write','mcp:destroy'], bearer_methods_supported:['header'] };
}
export function authChallenge(scope = 'mcp:read') {
  let origin; try { origin = oauthConfig().origin; } catch { return 'Bearer'; }
  return `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="${scope}"`;
}
export function sendAuthError(res, e) {
  const status = e instanceof McpAuthError ? e.status : 401;
  res.set('Cache-Control','no-store');
  if (status === 401 || (status === 403 && e.scope)) res.set('WWW-Authenticate', `${authChallenge(e.scope)}, error="${status === 403 ? 'insufficient_scope' : 'invalid_token'}"`);
  return res.status(status).json({error: e instanceof McpAuthError ? e.code : 'invalid_access_token'});
}
