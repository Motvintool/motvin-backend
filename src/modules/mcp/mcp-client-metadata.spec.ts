import { isMetadataClientId, isPrivateAddress, readClientMetadata } from './mcp-client-metadata';

const URL_ID = 'https://tool.example/oauth/client.json';
const acceptAll = () => true;

describe('client ID metadata documents', () => {
  it('treats only https URLs with a path as metadata client ids', () => {
    expect(isMetadataClientId(URL_ID)).toBe(true);
    expect(isMetadataClientId('https://tool.example/')).toBe(false);
    expect(isMetadataClientId('http://tool.example/client.json')).toBe(false);
    expect(isMetadataClientId('https://user:pw@tool.example/client.json')).toBe(false);
    expect(isMetadataClientId('https://tool.example/client.json#x')).toBe(false);
    expect(isMetadataClientId('eyJhbGciOi.signed.token')).toBe(false);
  });

  it('flags private and loopback addresses, and lets public ones through', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.5', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ['8.8.8.8', '104.16.0.1', '2606:4700::1111']) expect(isPrivateAddress(ip)).toBe(false);
  });

  it('accepts a document that names itself and lists its redirects', () => {
    const client = readClientMetadata(URL_ID, { client_id: URL_ID, client_name: 'Tool', redirect_uris: ['https://tool.example/cb'] }, acceptAll);
    expect(client).toMatchObject({ client_id: URL_ID, client_name: 'Tool', redirect_uris: ['https://tool.example/cb'] });
  });

  it('refuses a document for another client, without redirects, or with a client secret', () => {
    expect(readClientMetadata(URL_ID, { client_id: 'https://other.example/c.json', redirect_uris: ['https://x/cb'] }, acceptAll)).toHaveProperty('error');
    expect(readClientMetadata(URL_ID, { client_id: URL_ID, redirect_uris: [] }, acceptAll)).toHaveProperty('error');
    expect(readClientMetadata(URL_ID, { client_id: URL_ID, redirect_uris: ['https://x/cb'], token_endpoint_auth_method: 'client_secret_basic' }, acceptAll)).toHaveProperty('error');
    expect(readClientMetadata(URL_ID, ['not', 'an', 'object'], acceptAll)).toHaveProperty('error');
  });

  it('accepts a client that prefers a signed key but also supports "none" (ChatGPT)', () => {
    const chatgpt = {
      client_id: URL_ID,
      client_name: 'ChatGPT',
      redirect_uris: ['https://chatgpt.com/connector/oauth/abc'],
      token_endpoint_auth_method: 'private_key_jwt',
      token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
      grant_types: ['authorization_code', 'refresh_token'],
    };
    expect(readClientMetadata(URL_ID, chatgpt, acceptAll)).toMatchObject({ client_name: 'ChatGPT' });
  });

  it('applies the server’s own redirect rule', () => {
    const result = readClientMetadata(URL_ID, { client_id: URL_ID, redirect_uris: ['javascript:alert(1)'] }, (uri) => !uri.startsWith('javascript:'));
    expect(result).toHaveProperty('error');
  });
});
