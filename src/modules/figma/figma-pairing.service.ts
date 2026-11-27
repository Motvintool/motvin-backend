import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import type { TokenResponse } from '../mcp/mcp-oauth.service';

/**
 * Hands the Figma plugin its tokens after the person approves on motvin.com.
 *
 * The plugin cannot receive a redirect, so it signs in the way a TV app does:
 *
 * 1. It makes a random secret `key`, keeps it, and opens
 *    motvin.com/figma/connect?pair=<sha256(key)> in the browser.
 * 2. The person signs in there and clicks Allow; the page posts the pair and
 *    their Firebase ID token, and the tokens are parked here under the pair.
 * 3. The plugin asks every few seconds with its `key`; the first ask after
 *    the approval gets the tokens, and they are gone from here.
 *
 * Only the plugin knows `key`, and the address only carries its hash, so a
 * leaked link cannot be claimed. Both sides show the pair's first characters
 * as a code to compare, so a link someone else sent cannot be approved by
 * mistake. Pairs live in memory for a few minutes: a restart in between only
 * means signing in again.
 */

const TTL_MS = 10 * 60 * 1000;
/** More waiting pairs than this means something is filling the map: the oldest go. */
const MAX_PAIRS = 5000;

export const PAIR_PATTERN = /^[0-9a-f]{64}$/;
export const KEY_PATTERN = /^[0-9a-f]{64}$/;

/** The code both screens show: the pair's first six characters, as ABC-123. */
export function pairCode(pair: string): string {
  const code = pair.slice(0, 6).toUpperCase();
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

@Injectable()
export class FigmaPairingService {
  private readonly approved = new Map<string, { tokens: TokenResponse & { email: string }; expiresAt: number }>();

  park(pair: string, tokens: TokenResponse & { email: string }): void {
    this.prune();
    if (this.approved.size >= MAX_PAIRS) this.approved.delete(this.approved.keys().next().value as string);
    this.approved.set(pair, { tokens, expiresAt: Date.now() + TTL_MS });
  }

  /** The tokens for this key's pair, once; null while the person has not approved yet. */
  claim(key: string): (TokenResponse & { email: string }) | null {
    this.prune();
    const pair = createHash('sha256').update(key).digest('hex');
    const entry = this.approved.get(pair);
    if (!entry) return null;
    this.approved.delete(pair);
    return entry.tokens;
  }

  private prune() {
    const now = Date.now();
    for (const [pair, entry] of this.approved) if (entry.expiresAt <= now) this.approved.delete(pair);
  }
}
