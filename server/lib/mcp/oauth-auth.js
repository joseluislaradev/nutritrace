import { createRemoteJWKSet, jwtVerify } from 'jose';
import { McpAuthError, oauthConfig } from './oauth-config.js';
const providers = new Map();
async function provider(config) {
  let cached = providers.get(config.issuer);
  if (cached && cached.expires > Date.now()) return cached.keys;
  const response = await fetch(new URL('.well-known/openid-configuration', config.issuer), {signal:AbortSignal.timeout(5000), redirect:'error'});
  if (!response.ok) throw new McpAuthError(503,'oauth_provider_unavailable');
  const doc = await response.json();
  const jwks = new URL(doc.jwks_uri);
  if (doc.issuer !== config.issuer || jwks.protocol !== 'https:' || jwks.origin !== new URL(config.issuer).origin || jwks.username || jwks.password || jwks.hash) throw new McpAuthError(503,'oauth_provider_invalid');
  const keys = createRemoteJWKSet(jwks, {timeoutDuration:5000});
  providers.set(config.issuer, {keys, expires:Date.now()+3600000});
  return keys;
}
export async function verifyOAuthToken(token, config = oauthConfig(), keys) {
  try {
    const {payload} = await jwtVerify(token, keys || await provider(config), {
      issuer:config.issuer, audience:config.resource, algorithms:['RS256'], requiredClaims:['exp','iat','sub'],
    });
    const now = Date.now()/1000;
    if (!Number.isFinite(payload.exp) || !Number.isFinite(payload.iat) || payload.iat > now+30 || payload.iat < config.validAfter || payload.exp <= payload.iat) throw new Error('time');
    if (payload.sub !== config.owner || (payload.azp || payload.client_id) !== config.clientId) throw new McpAuthError(403,'owner_not_allowed');
    let scopes = typeof payload.scope === 'string' ? payload.scope.split(/\s+/) : [];
    if (Array.isArray(payload.permissions)) scopes = scopes.filter(s => payload.permissions.includes(s));
    scopes = scopes.filter(s => ['mcp:read','mcp:write','mcp:goals:write'].includes(s));
    return {authKind:'oauth', userId:config.userId, scopes, principalId:`oauth:${payload.sub}`};
  } catch(e) {
    if (e instanceof McpAuthError) throw e;
    throw new McpAuthError(401,'invalid_access_token');
  }
}
