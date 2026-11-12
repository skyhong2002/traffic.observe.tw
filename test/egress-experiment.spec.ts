import { describe, expect, it } from 'vitest';
import { curlResponse, experimentRoutes, requestViaEgress } from '../src/egress-experiment.ts';

describe('bounded Vessel transport', () => {
  it('uses the same HTTP client and identity, binds only VPN requests, and keeps headers out of process arguments', async () => {
    const calls: Array<{ command: string; args: string[]; input: string }> = [];
    const init = { headers: { 'x-sw-ctx': 'fixed-device.signature', origin: 'chrome-extension://existing' } };
    for (const route of experimentRoutes) {
      const response = await requestViaEgress(
        route,
        'https://data.similarweb.com/api/v1/data?domain=sample.tw',
        init,
        async (command, args, input) => {
          calls.push({ command, args, input });
          return 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"ok":true}';
        },
      );
      expect(await response.json()).toEqual({ ok: true });
    }
    expect(calls.map((c) => c.command)).toEqual(['curl', 'curl', 'ssh']);
    expect(calls[0].input).not.toContain('interface');
    expect(calls[1].input).toContain('interface = "10.8.1.6"');
    expect(calls[2].input).toContain('interface = "10.8.1.8"');
    expect(calls[2].args).toContain('mint-mbp');
    for (const call of calls) {
      expect(call.args.join(' ')).not.toContain('fixed-device.signature');
      expect(call.input).toContain('x-sw-ctx: fixed-device.signature');
      expect(call.input).toContain('retry = 0');
      expect(call.input).toContain('http1.1');
      expect(call.input).toContain('ipv4');
      expect(call.input).toContain('proxy = ""');
      expect(call.input).not.toContain('location');
    }
  });
  it('passes through refusal headers and bodies, including informational responses', async () => {
    const response = curlResponse(
      'HTTP/1.1 103 Early Hints\r\nLink: </a>\r\n\r\nHTTP/1.1 429 Too Many Requests\r\nRetry-After: 604800\r\n\r\n{"exceeded":true}',
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('604800');
    expect(await response.json()).toEqual({ exceeded: true });
    expect(() => curlResponse('not a response')).toThrow('invalid HTTP headers');
  });
  it('rejects other destinations and fails once without switching exit on a transport error', async () => {
    let calls = 0;
    const execute = async () => {
      calls++;
      throw Error('tunnel unavailable');
    };
    await expect(requestViaEgress('vessel-tokyo', 'https://example.com/', {}, execute)).rejects.toThrow('existing Similarweb');
    expect(calls).toBe(0);
    await expect(requestViaEgress('vessel-tokyo', 'https://data.similarweb.com/api/v1/data?domain=sample.tw', {}, execute)).rejects.toThrow(
      'tunnel unavailable',
    );
    expect(calls).toBe(1);
  });
});
