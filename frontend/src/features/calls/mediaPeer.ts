import type { CallType } from "./types";

export type TrackSyncResult = { added: MediaStreamTrack[]; replaced: MediaStreamTrack[] };

function senderKind(sender: RTCRtpSender, peer: RTCPeerConnection) {
  if (sender.track?.kind) return sender.track.kind;
  return peer.getTransceivers().find((item) => item.sender === sender)?.receiver.track.kind;
}

export async function syncLocalTracksToPeer(
  peer: RTCPeerConnection,
  stream: MediaStream,
  callType: CallType,
): Promise<TrackSyncResult> {
  const result: TrackSyncResult = { added: [], replaced: [] };
  const desired = stream.getTracks().filter((track) => track.kind === "audio" || (callType === "video" && track.kind === "video"));

  for (const track of desired) {
    const sender = peer.getSenders().find((item) => senderKind(item, peer) === track.kind);
    if (!sender) {
      peer.addTrack(track, stream);
      result.added.push(track);
    } else if (sender.track?.id !== track.id || sender.track.readyState === "ended") {
      await sender.replaceTrack(track);
      result.replaced.push(track);
    }
  }

  for (const kind of callType === "video" ? ["audio", "video"] : ["audio"]) {
    const exists = peer.getTransceivers().some((item) => item.receiver.track.kind === kind);
    if (!exists) peer.addTransceiver(kind, { direction: "sendrecv" });
  }

  return result;
}

export function hasRequiredLocalSenders(peer: RTCPeerConnection, callType: CallType, audioOnly = false) {
  const liveKinds = new Set(peer.getSenders().filter((sender) => sender.track?.readyState === "live").map((sender) => sender.track?.kind));
  return liveKinds.has("audio") && (callType === "audio" || audioOnly || liveKinds.has("video"));
}
