import { describe, expect, it, vi } from "vitest";
import { canMarkCallMediaConnected, hasRequiredLocalSenders, syncLocalTracksToPeer } from "./mediaPeer";

function track(kind: "audio" | "video", id: string, readyState: MediaStreamTrackState = "live") {
  return { kind, id, readyState } as MediaStreamTrack;
}

function peerFixture(initial: MediaStreamTrack[] = []) {
  const senders = initial.map((item) => ({ track: item, replaceTrack: vi.fn(async function (this: { track: MediaStreamTrack }, next: MediaStreamTrack) { this.track = next; }) }));
  return {
    senders,
    peer: {
      getSenders: () => senders,
      getTransceivers: () => senders.map((sender) => ({ sender, receiver: { track: { kind: sender.track.kind } } })),
      addTrack: vi.fn((next: MediaStreamTrack) => senders.push({ track: next, replaceTrack: vi.fn() })),
      addTransceiver: vi.fn(),
    } as unknown as RTCPeerConnection,
  };
}

describe("syncLocalTracksToPeer", () => {
  it("adds missing audio and video without recreating the peer", async () => {
    const fixture = peerFixture();
    const tracks = [track("audio", "a1"), track("video", "v1")];
    const stream = { getTracks: () => tracks } as MediaStream;
    const result = await syncLocalTracksToPeer(fixture.peer, stream, "video");
    expect(result.added).toEqual(tracks);
    expect(fixture.peer.addTrack).toHaveBeenCalledTimes(2);
    expect(hasRequiredLocalSenders(fixture.peer, "video")).toBe(true);
  });

  it("does not duplicate an existing sender", async () => {
    const audio = track("audio", "a1");
    const fixture = peerFixture([audio]);
    await syncLocalTracksToPeer(fixture.peer, { getTracks: () => [audio] } as MediaStream, "audio");
    expect(fixture.peer.addTrack).not.toHaveBeenCalled();
  });

  it("replaces an ended sender track", async () => {
    const fixture = peerFixture([track("audio", "old", "ended")]);
    const next = track("audio", "new");
    const result = await syncLocalTracksToPeer(fixture.peer, { getTracks: () => [next] } as MediaStream, "audio");
    expect(result.replaced).toEqual([next]);
  });
});

describe("call media connection gate", () => {
  it("does not mark a call connected before remote media arrives", () => {
    expect(canMarkCallMediaConnected("connected", "connected", false)).toBe(false);
  });

  it("marks connected only when transport and remote media are both ready", () => {
    expect(canMarkCallMediaConnected("connected", "connected", true)).toBe(true);
    expect(canMarkCallMediaConnected("connecting", "checking", true)).toBe(false);
  });
});
