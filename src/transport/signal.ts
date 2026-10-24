// Copy-paste signalling codes. A session description is JSON-encoded,
// deflate-compressed and base64url-encoded behind a short version prefix, so a
// player can paste it into a chat message. Whitespace is ignored on decode,
// because chat apps like to wrap long strings.
//
// Codes for reconnecting a match in progress also carry the match id, and an
// invite carries the inviter's seat, since either player may make it.

export interface Signal {
  readonly type: 'offer' | 'answer';
  readonly sdp: string;
  /** The inviter's seat (offers only); a fresh match's inviter is seat 0. */
  readonly seat?: 0 | 1;
  /** The match being reconnected, if any. */
  readonly match?: string;
}

const PREFIX = 'LG1.';

export class SignalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignalError';
  }
}

export async function encodeSignal(signal: Signal): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify({ type: signal.type, sdp: signal.sdp, seat: signal.seat, match: signal.match }));
  return PREFIX + toBase64Url(await transform(json, new CompressionStream('deflate-raw')));
}

/** Decode a pasted code, checking it is the kind of description we expect. */
export async function decodeSignal(code: string, expected: Signal['type']): Promise<Signal> {
  const compact = code.replace(/\s+/g, '');
  if (!compact.startsWith(PREFIX)) throw new SignalError('this is not a Land Game code');
  let parsed: unknown;
  try {
    const bytes = await transform(fromBase64Url(compact.slice(PREFIX.length)), new DecompressionStream('deflate-raw'));
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new SignalError('the code is damaged; copy it again in full');
  }
  const { type, sdp, seat, match } = (parsed ?? {}) as { type?: unknown; sdp?: unknown; seat?: unknown; match?: unknown };
  if ((type !== 'offer' && type !== 'answer') || typeof sdp !== 'string') {
    throw new SignalError('the code is damaged; copy it again in full');
  }
  if ((seat !== undefined && seat !== 0 && seat !== 1) || (match !== undefined && typeof match !== 'string')) {
    throw new SignalError('the code is damaged; copy it again in full');
  }
  if (type !== expected) {
    throw new SignalError(expected === 'answer' ? 'that is an invite code; paste the reply code instead' : 'that is a reply code; paste the invite code instead');
  }
  return { type, sdp, ...(seat === undefined ? {} : { seat }), ...(match === undefined ? {} : { match }) };
}

async function transform(bytes: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  const output = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(output).arrayBuffer());
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
