/** Preserve the primary OAuth descriptor that SDK 1.x drops at registration.
 * Use the public transport API so schema generation and tool dispatch remain
 * owned by the SDK. The legacy _meta mirror remains for older clients.
 */
export function preserveDiscoveryMetadata(transport, res) {
  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    if (Array.isArray(message.result?.tools)) {
      const tools = message.result.tools.map(tool => tool._meta?.securitySchemes
        ? {...tool, securitySchemes: tool._meta.securitySchemes}
        : tool);
      res.locals.mcpToolCount = tools.length;
      message = {...message, result: {...message.result, tools}};
    }
    if (Number.isInteger(message.error?.code)) res.locals.mcpRpcError = message.error.code;
    return send(message, options);
  };
}
