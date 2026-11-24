// The live link's connection in the app: a WebRTC data channel between two of the user's devices. What it carries and
// how the two find each other is in core/live.ts.
import type { Wire } from '../core/live.ts';

/** Whether this app can make direct connections at all. */
export const liveSupported = (): boolean => typeof RTCPeerConnection !== 'undefined';

/** How long addresses are gathered for before an offer or answer goes out with those found: an unreachable helper server must not hold it up. */
const GATHER_MS = 4_000;
/** A connection that lost its path gets this long to find it again. */
const LOST_MS = 8_000;

/**
 * The helper server a link may ask for this device's public address, as WebRTC wants it, or '' for none: with none,
 * two devices connect only on the same network, and no third party learns anything.
 */
export function stunUrl(setting: string): string {
  const s = setting.trim();
  if (!s || stunProblem(s)) return '';
  return /^stuns?:/i.test(s) ? s : `stun:${s}`;
}

/** What is wrong with an address typed for the helper server, or ''. One that is wrong counts as none, so links on the same network still form. */
export function stunProblem(setting: string): string {
  const s = setting.trim();
  return !s || /^(?:stuns?:)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/i.test(s) ? '' : 'That is not the address of a STUN server. Enter its name and port, such as stun.example.com:3478.';
}

export function rtcWire(stun: string): Wire {
  const pc = new RTCPeerConnection({ iceServers: stun ? [{ urls: stun }] : [] });
  let channel: RTCDataChannel | undefined;
  let ended = false;
  let lost: number | undefined;
  const end = () => {
    if (ended) return;
    ended = true;
    window.clearTimeout(lost);
    wire.onclose?.();
  };
  const use = (c: RTCDataChannel) => {
    channel = c;
    c.onopen = () => wire.onopen?.();
    c.onmessage = (e) => {
      if (typeof e.data === 'string') wire.onmessage?.(e.data);
    };
    c.onclose = end;
  };
  pc.oniceconnectionstatechange = () => {
    const state = pc.iceConnectionState;
    window.clearTimeout(lost);
    if (state === 'failed' || state === 'closed') end();
    else if (state === 'disconnected') lost = window.setTimeout(end, LOST_MS);
  };
  // Every address goes in the one document the other device reads, so the offer waits until they are all found.
  const gathered = () =>
    new Promise<void>((done) => {
      if (pc.iceGatheringState === 'complete') return done();
      const timer = window.setTimeout(done, GATHER_MS);
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState !== 'complete') return;
        window.clearTimeout(timer);
        done();
      });
    });
  const local = async (): Promise<string> => {
    await gathered();
    const sdp = pc.localDescription?.sdp;
    if (!sdp) throw new Error('No connection details were made');
    return sdp;
  };
  const wire: Wire = {
    async offer() {
      use(pc.createDataChannel('coffer'));
      await pc.setLocalDescription(await pc.createOffer());
      return local();
    },
    async answer(offer) {
      pc.ondatachannel = (e) => use(e.channel);
      await pc.setRemoteDescription({ type: 'offer', sdp: offer });
      await pc.setLocalDescription(await pc.createAnswer());
      return local();
    },
    async accept(answer) {
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    },
    send(text) {
      if (channel?.readyState !== 'open') throw new Error('The link is not open');
      channel.send(text);
    },
    close() {
      ended = true;
      window.clearTimeout(lost);
      channel?.close();
      pc.close();
    },
  };
  return wire;
}
