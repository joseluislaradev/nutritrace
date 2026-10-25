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
    if (!Number.isFinite(payload.exp) || !Number.isFinite(payload.iat) || payload.iat > now+30 || payload.iat < config.validAfter || payload.exp <= payload.iat) throw new McpAuthError(401,'invalid_access_token',undefined,'jwt_time');
    if (payload.sub !== config.owner) throw new McpAuthError(403,'owner_not_allowed',undefined,'owner_mismatch');
    if ((payload.azp || payload.client_id) !== config.clientId) throw new McpAuthError(403,'owner_not_allowed',undefined,'client_mismatch');
    let scopes = typeof payload.scope === 'string' ? payload.scope.split(/\s+/) : [];
    if (Array.isArray(payload.permissions)) scopes = scopes.filter(s => payload.permissions.includes(s));
    scopes = scopes.filter(s => ['mcp:read','mcp:write','mcp:goals:write','mcp:destroy'].includes(s));
    return {authKind:'oauth', userId:config.userId, scopes, principalId:`oauth:${payload.sub}`};
  } catch(e) {
    if (e instanceof McpAuthError) throw e;
    const claimReasons = {iss:'jwt_issuer',aud:'jwt_audience',exp:'jwt_exp',iat:'jwt_iat',sub:'jwt_sub',nbf:'jwt_nbf'};
    const codeReasons = {ERR_JWT_EXPIRED:'jwt_expired',ERR_JWS_SIGNATURE_VERIFICATION_FAILED:'jwt_signature',ERR_JWKS_NO_MATCHING_KEY:'jwt_key'};
    const diagnostic = codeReasons[e?.code] || (e?.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && claimReasons[e.claim]) || 'jwt_invalid';
    throw new McpAuthError(401,'invalid_access_token',undefined,diagnostic);
  }
}
